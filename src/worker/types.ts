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
}

export interface MomentRow {
  id: string;
  event_id: string;
  uploader_name: string;
  media_url: string;
  caption: string | null;
  points_awarded: number;
  created_at: string;
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
