/** Shared types for gmeet-notes. */

export interface OAuthConfig {
  client_id: string;
  client_secret: string;
  refresh_token: string;
  access_token?: string;
  expires_at?: number;
  scope?: string;
  token_endpoint?: string;
  /** Authenticated account email (organizer OR admitted participant). */
  email?: string;
  /** Calendar id to correlate against (defaults to email or "primary"). */
  calendar_id?: string;
}

export type CorrStatus = "MATCHED" | "REVIEW" | "UNMATCHED";

export interface NoteRecord {
  id: string;
  meeting_code: string;
  space_name: string;
  conference_record: string;
  actual_start?: string;
  actual_end?: string;
  document_id: string;
  doc_url?: string;
  content_hash: string;
  content: string;
  title?: string;
  organizer?: string;
  attendees: string[];
  event_id?: string;
  ical_uid?: string;
  scheduled_start?: string;
  scheduled_end?: string;
  corr_status: CorrStatus;
  corr_score: number;
  state: "new" | "processed";
  first_seen: string;
  last_synced: string;
  processed_at?: string;
}

/** Loose shape for Google Calendar events (validated on read, never trusted). */
export interface CalEvent {
  id?: string;
  iCalUID?: string;
  summary?: string;
  organizer?: { email?: string };
  attendees?: Array<{ email?: string }>;
  attachments?: Array<{ fileId?: string }>;
  conferenceData?: { conferenceId?: string };
  start?: { dateTime?: string };
  end?: { dateTime?: string };
}

export interface CorrelationResult {
  status: CorrStatus;
  score: number;
  event: CalEvent | null;
}

/** Shape emitted to the routine / agent (mirrors the integration guide). */
export interface PublicItem {
  id: string;
  meetingCode: string;
  title?: string;
  calendar: {
    eventId?: string;
    iCalUID?: string;
    summary?: string;
    organizer?: string;
    attendees: string[];
    scheduledStart?: string;
    scheduledEnd?: string;
  };
  meet: {
    space: string;
    conferenceRecord: string;
    actualStart?: string;
    actualEnd?: string;
  };
  smartNote: {
    name: string;
    documentId: string;
    state: "FILE_GENERATED";
    docUrl?: string;
    contentHash: string;
  };
  content: string;
  correlation: { status: CorrStatus; score: number };
  firstSeen: string;
}

export interface SyncBatch {
  syncedAt: string;
  window: { from: string; to: string };
  newCount: number;
  items: PublicItem[];
}
