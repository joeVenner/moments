export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  ADMIN_USER: string;
  ADMIN_PASSWORD: string;
  // Optional: AI banner generation is inert (returns 501) when unset.
  OPENAI_API_KEY?: string;
  // Optional: presigned large direct-to-R2 uploads are inert (returns 501)
  // unless all three S3 credentials are set. See presign.ts / .agent P3.1.
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_S3_ENDPOINT?: string;
  R2_BUCKET_NAME?: string;
  // Optional Cloudflare Stream direct-creator upload configuration. Account ID
  // and customer code are non-secret; the token must be a Worker secret.
  STREAM_ACCOUNT_ID?: string;
  STREAM_API_TOKEN?: string;
  STREAM_CUSTOMER_CODE?: string;
}

export interface EventRow {
  id: string;
  slug: string;
  title: string;
  type: string;
  main_characters: string | null;
  description: string | null;
  cover_image_url: string | null;
  created_at: string;
  starts_at: string | null;
  expires_at: string | null;
  archived_at: string | null;
  access_mode: "public" | "private";
  access_pin_hash: string | null;
  access_pin_salt: string | null;
  invite_token: string | null;
}

export interface MomentRow {
  id: string;
  event_id: string;
  uploader_name: string;
  media_url: string;
  caption: string | null;
  points_awarded: number;
  created_at: string;
  size_bytes: number | null;
  mime_type: string | null;
  moderation_status: "approved" | "hidden";
  reaction_count?: number;
  reacted?: number;
}

export interface ParticipantRow {
  id: string;
  event_id: string;
  nickname: string;
  avatar_seed: string | null;
  joined_at: string;
}

export interface LeaderboardEntry {
  uploader_name: string;
  total_points: number;
  moment_count: number;
}

/** A resumable multipart upload in flight. See migrations/0004_uploads.sql. */
export interface UploadRow {
  id: string;
  event_id: string;
  uploader_name: string;
  key: string;
  upload_id: string;
  content_type: string | null;
  size_bytes: number;
  status: "open" | "completed" | "aborted";
  created_at: string;
  completed_at: string | null;
}
