import type { InteractionRequestIdentity, InteractionResponseAcknowledgement, InteractionResponseSubmission, InteractionState, PanelDeclaration, PanelDocument } from "../panels/contract.js";
import type { InteractionResult, PreparedForm } from "../panels/forms.js";
export interface InteractionRequestInput { panel: string; document: PanelDocument; timeout_ms?: number }
export interface InteractionContext { request(input: InteractionRequestInput): Promise<InteractionResult> }
export interface InteractionRequest {
  identity: InteractionRequestIdentity; declaration: PanelDeclaration; document: PanelDocument;
  formBlockId: string; form: PreparedForm; revision: number; state: InteractionState;
  createdAt: number; deadline: number; canonicalResult?: string;
}
export interface InteractionRequestView extends InteractionRequest { presentation: { declaration: PanelDeclaration; stale: boolean } }
export type InteractionAdapter = (request: InteractionRequest, signal: AbortSignal) => Promise<InteractionResponseSubmission>;
export class InteractionError extends Error {
  constructor(readonly code: "interaction_unavailable" | "interaction_invalid" | "interaction_not_found" | "interaction_conflict", message: string) {
    super(message); this.name = "InteractionError";
  }
}
export interface InteractionSettlement {
  request: InteractionRequest; acknowledgement: InteractionResponseAcknowledgement;
}
