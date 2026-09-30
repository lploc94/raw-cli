import type { InteractionRequest } from "../../../../src/interactions/contract.js";
import { formRequest } from "../interaction-state.js";
import { useEffect, useId, useRef, useState } from "react";
import type { FormAnswers, FormField, InteractionResponseAcknowledgement } from "../../../../src/panels/contract.js";
import { validateFormAnswers } from "../../../../src/panels/forms.js";
import { resolveAction } from "../../../../src/panels/actions.js";
import { errorText } from "../../api.js";
import { useActionScope } from "../actions.js";

export function Form({ blockId, fields }: { blockId: string; fields: FormField[] }) {
  const scope = useActionScope();
  const request = formRequest(scope?.item, scope?.host.interactions ?? [], blockId);
  return <FormControls key={request?.identity.requestId ?? "unavailable"} blockId={blockId} fields={fields} request={request} scope={scope} />;
}

/** React owns draft/ACK/busy state per request; late work belongs to the unmounted old control. */
function FormControls({ blockId, fields, request, scope }: {
  blockId: string; fields: FormField[]; request: InteractionRequest | undefined; scope: ReturnType<typeof useActionScope>;
}) {
  const prefix = useId();
  const [draft, setDraft] = useState<FormAnswers>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [ack, setAck] = useState<InteractionResponseAcknowledgement>();
  const retry = useRef<{ body: string; key: string } | undefined>(undefined);
  const currentAck = ack?.requestId === request?.identity.requestId ? ack : undefined;
  const canonicalResult = request?.canonicalResult ?? currentAck?.canonicalResult;
  useEffect(() => {
    if (canonicalResult) {
      const result = JSON.parse(canonicalResult) as { answers?: FormAnswers };
      if (result.answers) setDraft(result.answers);
    }
  }, [canonicalResult]);
  const state = currentAck?.state ?? request?.state;
  const disabled = !request || state !== "pending" || busy || !scope?.host.respond;
  const actions = request?.declaration.actions.filter(action => {
    if (action.kind !== "response") return false;
    try { resolveAction(request.declaration, { action: action.id, block: blockId }, request.document); return true; } catch { return false; }
  }) ?? [];
  const submit = async (response: "submit" | "cancel") => {
    if (disabled || !request || !scope?.host.respond) return;
    try {
      const answers = response === "submit" ? validateFormAnswers(request.form, draft) : undefined;
      const body = JSON.stringify({ response, answers });
      if (retry.current?.body !== body) retry.current = { body, key: crypto.randomUUID() };
      setError(""); setBusy(true);
      setAck(await scope.host.respond(request, { requestId: request.identity.requestId, expectedRevision: request.revision,
        idempotencyKey: retry.current.key, ...(response === "submit" ? { response, answers: answers! } : { response }) }));
    } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
  };
  return <div className="panel-form">
    {!request && <p role="note">Responses are unavailable for this form.</p>}
    {request && <p className="muted small" role="status">{state === "pending" ? "Waiting for your answer" : `Question ${state}`}</p>}
    <fieldset disabled={disabled}>
      <legend className="sr-only">Tool question</legend>
      {(request?.form.fields ?? fields).map(field => {
        const id = `${prefix}-${field.id}`;
        const description = field.description ? `${id}-description` : undefined;
        const value = Object.hasOwn(draft, field.id) ? draft[field.id] : undefined;
        const update = (value: string | string[]) => setDraft(previous => {
          const next = { ...previous, [field.id]: value };
          if (!field.required && Array.isArray(value) && value.length === 0) delete next[field.id];
          return next;
        });
        return <div className="panel-form-field" key={field.id}>
          {field.kind === "multi_select" ? <fieldset aria-describedby={description}>
            <legend>{field.label}</legend>
            {field.options.map(option => <label key={option.id}><input type="checkbox" disabled={!Array.isArray(value) ? field.max_selected === 0 : !value.includes(option.id) && value.length >= (field.max_selected ?? field.options.length)} checked={Array.isArray(value) && value.includes(option.id)}
              onChange={event => update(event.target.checked ? [...(Array.isArray(value) ? value : []), option.id] : (Array.isArray(value) ? value : []).filter(id => id !== option.id))} />{option.label}</label>)}
          </fieldset> : <>
            <label htmlFor={id}>{field.label}</label>
            {field.kind === "text" ? field.multiline
              ? <textarea id={id} aria-describedby={description} value={typeof value === "string" ? value : ""} onChange={event => update(event.target.value)} />
              : <input id={id} type="text" aria-describedby={description} value={typeof value === "string" ? value : ""} onChange={event => update(event.target.value)} />
              : <select id={id} aria-describedby={description} value={typeof value === "string" ? value : ""} onChange={event => { if (event.target.value) update(event.target.value); else setDraft(previous => { const next = { ...previous }; delete next[field.id]; return next; }); }}>
                <option value="">Choose an option</option>{field.options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>}
          </>}
          {field.description && <p id={description} className="muted small">{field.description}</p>}
          {field.kind === "text" && request && <small className="muted">Up to {field.max_bytes} UTF-8 bytes</small>}
        </div>;
      })}
    </fieldset>
    {error && <p className="error small" role="alert">{error}</p>}
    {!!request && <p className="muted small">Answer budget: {request.form.maxResultBytes} encoded bytes</p>}
    <div className="panel-form-actions">{actions.map(action => <button key={action.id} type="button" disabled={disabled} onClick={() => void submit(action.response!)}>{action.label}</button>)}</div>
  </div>;
}
