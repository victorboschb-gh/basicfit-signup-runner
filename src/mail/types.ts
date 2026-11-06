export interface MailAddress {
  address: string;
  name: string;
}

export interface MailMessage {
  id: string;
  subject: string;
  from: MailAddress;
  createdAt: string;
  text: string;
  html: string;
}

export interface WaitOptions {
  timeoutMs: number;
  pollMs?: number;
  label: string;
  /** Solo mensajes recibidos a partir de este instante (ISO). */
  since?: string;
  /** IDs ya usados en pasos anteriores. */
  excludeIds?: string[];
  /** Predicado adicional sobre el mensaje completo. */
  match?: (message: MailMessage) => boolean;
}

export interface Mailbox {
  readonly address: string;
  readonly password: string;
  waitForMessage(options: WaitOptions): Promise<MailMessage>;
  getMessage(id: string): Promise<MailMessage>;
  close(): Promise<void>;
}
