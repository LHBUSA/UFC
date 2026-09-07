/* Clip labels for the video desk (docs/videos.md classifier families). Plain
 * module so both server components (rails, grouping) and the client player
 * can import it. */
export const VIDEO_TYPE_LABEL: Record<string, string> = {
  embedded_episode: "Embedded", countdown: "Countdown", fight_preview: "Preview", full_fight: "Free fight", highlights: "Highlights", interview: "Interview",
  press_conference: "Press conference", media_day: "Media day", weigh_in: "Weigh-in", faceoff: "Faceoff", post_fight: "Reaction", analysis: "Breakdown", other: "Official video",
};
