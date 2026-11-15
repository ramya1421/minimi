/**
 * search.ts — search-related types
 *
 * The actual search tool is defined in agent.ts as a typed constant using the
 * WebSearchTool20250305 type from the SDK. This file holds the shared
 * SearchRecord type used to report search activity to the client.
 */

/**
 * A record of one search performed during a turn, used for the UI status line
 * and the metadata sent in the "done" event.
 */
export interface SearchRecord {
  query: string;
  resultCount: number;
  durationMs: number;
}
