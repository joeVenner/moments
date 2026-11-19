import { describe, expect, it } from "vitest";
import { gridPhotoSources, videoPoster } from "./gridImage";

describe("gridPhotoSources", () => {
  it("tries the thumbnail, then the original", () => {
    expect(gridPhotoSources({ media_url: "/media/a.jpg", thumb_url: "/media/a.jpg.thumb.jpg" }))
      .toEqual(["/media/a.jpg.thumb.jpg", "/media/a.jpg"]);
  });
  it("shows the original when there is no thumbnail (older pages, failed thumbnails)", () => {
    expect(gridPhotoSources({ media_url: "/media/a.jpg", thumb_url: null })).toEqual(["/media/a.jpg"]);
    expect(gridPhotoSources({ media_url: "/media/a.jpg" })).toEqual(["/media/a.jpg"]);
    expect(gridPhotoSources({ media_url: "/media/a.jpg", thumb_url: "" })).toEqual(["/media/a.jpg"]);
  });
  it("never lists the same image twice, and keeps a pending preview as is", () => {
    expect(gridPhotoSources({ media_url: "/media/a.jpg", thumb_url: "/media/a.jpg" })).toEqual(["/media/a.jpg"]);
    expect(gridPhotoSources({ media_url: "blob:https://moments-hq.com/1" })).toEqual(["blob:https://moments-hq.com/1"]);
  });
});

describe("videoPoster", () => {
  it("uses the thumbnail, never the video", () => {
    expect(videoPoster({ media_url: "/media/v.mp4", thumb_url: "/media/v.mp4.thumb.jpg" })).toBe("/media/v.mp4.thumb.jpg");
    expect(videoPoster({ media_url: "/media/v.mp4", thumb_url: null })).toBeNull();
    expect(videoPoster({ media_url: "/media/v.mp4" })).toBeNull();
  });
});
