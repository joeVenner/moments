export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  ADMIN_USER: string;
  ADMIN_PASSWORD: string;
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
