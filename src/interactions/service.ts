import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import type { FormField, InteractionResponseAcknowledgement, InteractionResponseSubmission, InteractionState, PanelDeclaration, PanelDocument, ToolCallUIIdentity } from "../panels/contract.js";
import { canonicalInteractionResult, prepareForm, validateFormAnswers, type InteractionResult } from "../panels/forms.js";
import { resolveAction } from "../panels/actions.js";
import { validateDocument } from "../panels/validate.js";
import type { SessionOwner, SessionStore } from "../sessions/store.js";
import { InteractionError, type InteractionAdapter, type InteractionContext, type InteractionRequest, type InteractionSettlement } from "./contract.js";

export interface InteractionCallBinding {
  identity: ToolCallUIIdentity; owner?: SessionOwner; maxOutputBytes: number; signal?: AbortSignal;
  prepare(panel: string): { declaration: PanelDeclaration; viewInstanceId?: string };
  publish(panel: string, document: PanelDocument): Promise<void>;
}
const stable = (input: unknown): string => JSON.stringify(input, (_key, value: unknown) => value && typeof value === "object" && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
const conflict = (): never => { throw new InteractionError("interaction_conflict", "request already settled or revision changed"); };

/** Host-scoped waits; durable state remains authoritative, never a recovered Promise. */
export class InteractionService {
  private readonly records = new Map<string, InteractionRequest>();
  private readonly submissions = new Map<string, { key: string; body: string }>();
  private readonly waiting = new Map<string, { request: InteractionRequest; finish(request: InteractionRequest): void }>();
  private closed = false;
  constructor(private readonly options: { store?: SessionStore; available?: boolean; adapter?: InteractionAdapter;
    publish?: (request: InteractionRequest) => void } = {}) { options.store?.recoverInteractions(); }

  assertStoreBinding(store: SessionStore): void {
    if (!this.options.store || this.options.store.storeId !== store.storeId || realpathSync(this.options.store.path) !== realpathSync(store.path))
      throw new InteractionError("interaction_invalid", "persisted agents require an interaction service bound to the same session store");
  }

  get(sessionId: string | undefined, id: string): InteractionRequest | undefined {
    if (sessionId && this.options.store) return this.options.store.getInteraction(sessionId, id);
    const record = this.records.get(id);
    return record && record.identity.sessionId === sessionId ? structuredClone(record) : undefined;
  }
  forCall(binding: InteractionCallBinding): InteractionContext {
    return { request: async input => {
      if (this.closed || (!this.options.available && !this.options.adapter)) throw new InteractionError("interaction_unavailable", "interaction_unavailable: this host has no response adapter");
      if (binding.signal?.aborted) return { status: "cancelled" };
      const timeout = input.timeout_ms ?? 30 * 60 * 1000;
      if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 24 * 60 * 60 * 1000) throw new InteractionError("interaction_invalid", "timeout_ms must be positive and at most 24 hours");
      validateDocument(input.document);
      const forms = input.document.blocks.filter(block => block.kind === "form");
      if (forms.length !== 1) throw new InteractionError("interaction_invalid", "a request must contain exactly one form block");
      const block = forms[0]!;
      const prepared = binding.prepare(input.panel);
      for (const response of ["submit", "cancel"] as const) {
        const action = prepared.declaration.actions.find(action => action.kind === "response" && action.response === response && (!action.blocks || action.blocks.includes(block.id)));
        if (!action) throw new InteractionError("interaction_invalid", `the declared form needs a ${response} response action`);
        resolveAction(prepared.declaration, { action: action.id, block: block.id }, input.document);
      }
      const form = prepareForm((block as { fields: FormField[] }).fields, binding.maxOutputBytes);
      const document = structuredClone(input.document);
      const createdAt = Date.now();
      const request: InteractionRequest = { identity: { ...binding.identity, panelId: prepared.declaration.id, requestId: randomUUID(),
        ...(prepared.viewInstanceId ? { viewInstanceId: prepared.viewInstanceId } : {}) }, declaration: structuredClone(prepared.declaration),
        document, formBlockId: block.id, form, revision: 1, state: "pending", createdAt, deadline: createdAt + timeout };
      if (request.identity.sessionId && this.options.store) {
        if (!binding.owner) throw new InteractionError("interaction_invalid", "durable requests need the current call owner");
        this.options.store.createInteraction(request, binding.owner);
      } else this.records.set(request.identity.requestId, structuredClone(request));
      const id = request.identity.requestId;
      const controller = new AbortController();
      let finish!: (request: InteractionRequest) => void;
      const result = new Promise<InteractionResult>(resolve => {
        finish = terminal => {
          if (!this.waiting.delete(id)) return;
          clearTimeout(timer); if (watch) clearInterval(watch);
          binding.signal?.removeEventListener("abort", abort); controller.abort();
          resolve(JSON.parse(terminal.canonicalResult ?? canonicalInteractionResult({ status: (terminal.state === "answered" ? "interrupted" : terminal.state) as Exclude<InteractionState,"pending" | "answered"> })) as InteractionResult);
        };
      });
      const terminate = (state: Exclude<InteractionState,"pending">) => {
        try { const settled = this.settle(request, state); this.deliver(settled.request); }
        catch { const current = this.get(request.identity.sessionId, id); if (current && current.state !== "pending") this.deliver(current); }
      };
      const abort = () => terminate("cancelled");
      const timer = setTimeout(() => terminate("expired"), timeout);
      const watch = this.options.store ? setInterval(() => {
        this.options.store!.recoverInteractions();
        const current = this.get(request.identity.sessionId, id);
        if (current && current.state !== "pending") this.deliver(current);
      }, 250) : undefined;
      watch?.unref();
      this.waiting.set(id, { request, finish });
      binding.signal?.addEventListener("abort", abort, { once: true });
      if (binding.signal?.aborted) abort();
      try {
        if (this.waiting.has(id)) {
          // The request and audit are committed before either observer or panel publication.
          this.publish(request);
          await binding.publish(input.panel, document);
          if (this.options.adapter && this.waiting.has(id)) void this.options.adapter(structuredClone(request), controller.signal)
            .then(submission => { try { this.respond(request.identity.sessionId, id, submission); } catch { terminate("cancelled"); } }, () => terminate("cancelled"));
        }
      } catch (error) { terminate("interrupted"); await result; throw error; }
      return result;
    } };
  }

  private settle(request: InteractionRequest, state: Exclude<InteractionState,"pending">, canonicalResult?: string,
    submission?: { key: string; body: string }): InteractionSettlement {
    const id = request.identity.requestId;
    if (request.identity.sessionId && this.options.store)
      return this.options.store.settleInteraction(request.identity.sessionId, id, request.revision, state, canonicalResult, submission);
    const current = this.records.get(id);
    if (!current) throw new InteractionError("interaction_not_found", "request not found");
    const previous = this.submissions.get(id);
    if (!(submission && previous?.key === submission.key && previous.body === submission.body)) {
      if (current.state !== "pending" || current.revision !== request.revision || (submission && current.deadline <= Date.now())) conflict();
      if (state === "answered" && !canonicalResult) throw new InteractionError("interaction_invalid", "an answer requires its canonical result");
      current.state = state; current.revision++;
      current.canonicalResult = canonicalResult ?? canonicalInteractionResult({ status: state as Exclude<InteractionState,"pending" | "answered"> });
      if (submission) this.submissions.set(id, submission);
    }
    return { request: structuredClone(current), acknowledgement: { requestId: id, revision: current.revision,
      state: current.state as Exclude<InteractionState,"pending">, ...(current.canonicalResult ? { canonicalResult: current.canonicalResult } : {}) } };
  }
  private publish(request: InteractionRequest): void {
    try { this.options.publish?.(structuredClone(request)); } catch { /* observers never own the durable transition */ }
  }
  private deliver(request: InteractionRequest): void {
    const waiter = this.waiting.get(request.identity.requestId);
    if (!waiter) return;
    this.publish(request); waiter.finish(request);
  }

  respond(sessionId: string | undefined, id: string, raw: unknown): InteractionResponseAcknowledgement {
    this.options.store?.recoverInteractions();
    const request = this.get(sessionId, id);
    if (!request) throw new InteractionError("interaction_not_found", "request does not exist in this session");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new InteractionError("interaction_invalid", "response must be an object");
    const submission = raw as InteractionResponseSubmission;
    const allowed = ["requestId", "expectedRevision", "idempotencyKey", "response", ...(submission.response === "submit" ? ["answers"] : [])];
    if (Object.keys(raw).some(key => !allowed.includes(key)) || submission.requestId !== id || (!Number.isSafeInteger(submission.expectedRevision) || submission.expectedRevision < 1)
      || typeof submission.idempotencyKey !== "string" || !submission.idempotencyKey || submission.idempotencyKey.length > 128
      || !["submit", "cancel"].includes(submission.response)) throw new InteractionError("interaction_invalid", "invalid request identity, revision or response");
    const replay = { key: submission.idempotencyKey, body: stable(submission) };
    if (request.state !== "pending") {
      const settled = this.settle({ ...request, revision: submission.expectedRevision }, request.state, request.canonicalResult, replay);
      this.deliver(settled.request); return settled.acknowledgement;
    }
    const canonicalResult = submission.response === "submit"
      ? canonicalInteractionResult({ status: "answered", answers: validateFormAnswers(request.form, submission.answers) })
      : canonicalInteractionResult({ status: "cancelled" });
    const settled = this.settle({ ...request, revision: submission.expectedRevision }, submission.response === "submit" ? "answered" : "cancelled", canonicalResult,
      replay);
    this.deliver(settled.request);
    return settled.acknowledgement;
  }

  endCall(runId: string, toolCallId: string): void {
    for (const waiter of this.waiting.values()) if (waiter.request.identity.runId === runId && waiter.request.identity.toolCallId === toolCallId) {
      try { this.deliver(this.settle(waiter.request, "cancelled").request); } catch { /* a competing terminal CAS owns settlement */ }
    }
  }
  close(): void {
    this.closed = true;
    for (const waiter of [...this.waiting.values()]) {
      try { this.deliver(this.settle(waiter.request, "interrupted").request); } catch {
        const current = this.get(waiter.request.identity.sessionId, waiter.request.identity.requestId);
        if (current && current.state !== "pending") this.deliver(current);
      }
    }
  }
}
