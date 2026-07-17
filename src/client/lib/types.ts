export interface EventData {
  id: string;
  slug: string;
  title: string;
  type: string;
  main_characters: string | null;
  description: string | null;
  cover_image_url: string | null;
  created_at: string;
}

export interface MomentData {
  id: string;
  event_id: string;
  uploader_name: string;
  media_url: string;
  caption: string | null;
  points_awarded: number;
  created_at: string;
  size_bytes: number | null;
  mime_type: string | null;
}
