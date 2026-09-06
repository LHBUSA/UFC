/* Canonical UI barrel.
 *
 * Most of the application historically imports from @/components/ui. Keep
 * every existing primitive from ui.tsx, but deliberately override StoryCard
 * with the timestamped newsroom implementation so article freshness cannot
 * drift between home, news, fighter, fight and event surfaces. */
export * from "./ui";
export { NewsStoryCard as StoryCard } from "./NewsStoryCard";
