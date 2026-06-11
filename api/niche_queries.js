// =====================================================================
// InstaGen — Niche Query Builder (Data Access Layer)
// =====================================================================
// This module is the "conditional query builder" the spec calls for:
// it converts the active niche id (and the current calendar date) into
// a niche-specific query context that is injected into the upstream
// text-LLM calls BEFORE the AI filter agent picks the top items of
// the day.
//
// What lives here is NOT persona/voice (that's api/niche_profiles.js)
// and NOT a real external database. The LLM is still the data source
// — the niche system prompt already scopes it topically. This module
// adds a focused, EXPLICIT set of search terms, category filters, and
// a date window so the archivist agent queries the right slice of
// history on the right day.
//
// Resolution contract:
//   buildNicheQuery(nicheId, currentDate)  →  always returns a context
//                                            object (never null).
//                                            Unknown / null / empty
//                                            ids fall back to the
//                                            'history' context — the
//                                            original engine behavior.
//
// Context shape:
//   {
//     id              : 'women'                          // canonical snake_case
//     label           : "On This Day in Women's History" // mirrored from profile
//     searchTerms     : ["suffrage", "first woman", ...] // explicit keywords
//     categoryFilters : ['scientific breakthroughs', ...] // topic categories
//     dateWindow      : 'this day' | 'this day and the surrounding week'
//     directive       : 'Query the historical record ...' // injected into LLM
//     structuredHint  : 'When filtering for the most viral event, ...'
//                       // injected into the AI filter agent system prompt
//   }
//
// Adding a niche? Add a row to NICHE_QUERIES below; the factory picks
// it up automatically. The id MUST match a canonical id in
// api/niche_profiles.js (case-insensitive + alias lookup is already
// handled there, so kebab-case frontend ids like 'womens-history'
// resolve to the 'women' context without extra work here).
// =====================================================================

// ---------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------
// Reuse the niche profile factory so 'womens-history' / 'ancient-civ'
// / 'true-crime' / 'vintage-tech' (the kebab-case legacy ids from
// the frontend) all resolve to the right canonical id here without
// duplicating the alias table.
import { resolveNicheProfile } from './niche_profiles.js';

// ---------------------------------------------------------------------
// Default fallback id — pinned so the factory doesn't have to re-
// resolve "what's the default" on every call. The 'history' engine
// is the documented fallback for any unrecognized input.
// ---------------------------------------------------------------------
const DEFAULT_QUERY_ID = 'history';

// ---------------------------------------------------------------------
// Per-niche query registry
// ---------------------------------------------------------------------
// Each row encodes the explicit query the LLM should run for that
// niche on the given calendar date. The `directive` is the single
// most important field — it's the verbatim instruction injected as
// the first line of the archivist LLM's user message, so the model
// has the search brief in front of it before it starts producing
// events. The `structuredHint` is a shorter note used to bias the
// AI filter agent that picks the single most-viral event downstream
// (only used by /api/generate-daily-videos).
// ---------------------------------------------------------------------
export const NICHE_QUERIES = {
  // -----------------------------------------------------------------
  // 1) 'history' — the original engine. Broad query, no narrowing.
  //    Default fallback. dateWindow = this day.
  // -----------------------------------------------------------------
  history: {
    searchTerms: [],
    categoryFilters: [
      'major historical events',
      'world history',
      'political milestones',
      'scientific discoveries',
      'cultural shifts',
      'military turning points',
    ],
    dateWindow: 'this day',
    directive:
      'Query the historical record broadly for the most significant events that occurred on this calendar date across all eras and continents. Spread the 8 results across ancient empires, medieval breakthroughs, modern world wars, space-race achievements, and shocking historical turning points. Surface the most viral, mind-blowing, and conversation-starting events you can find.',
    structuredHint:
      'When filtering for the single most viral event, prioritize mind-blowing "did you know?" moments, historical coincidences, monumental discoveries, or massive tactical turning points over dry political treaties or generic birth/death announcements.',
  },

  // -----------------------------------------------------------------
  // 2) 'true_crime' — legal/investigative keywords tied to this day.
  //    Bias toward court case, heist, mystery, unsolved, arrest.
  // -----------------------------------------------------------------
  true_crime: {
    searchTerms: [
      'court case',
      'heist',
      'mystery',
      'unsolved',
      'arrest',
      'criminal trial',
      'forensic breakthrough',
      'cold case',
    ],
    categoryFilters: [
      'criminal cases',
      'famous heists',
      'unsolved mysteries',
      'mass arrests',
      'forensic milestones',
      'legal trials',
    ],
    dateWindow: 'this day',
    directive:
      'On this day, query historical crime records for: court cases, infamous heists, unsolved mysteries, mass arrests, forensic breakthroughs, and high-profile criminal captures that occurred on this exact calendar date. Use the search terms "court case", "heist", "mystery", "unsolved", "arrest" as your filter vocabulary. Bias toward historical cases with enduring mystery, dramatic investigations, or pioneering forensic science — avoid graphic contemporary violence.',
    structuredHint:
      'When filtering for the single most viral event, prioritize unsolved cases, dramatic heists, and forensic firsts over tragic contemporary incidents. Pick the case with the most "wait, what?!" payload.',
  },

  // -----------------------------------------------------------------
  // 3) 'philosophy' — philosophers born/died this day, plus a
  //    structured quote/letter dataset (Stoic, Eastern, etc.).
  // -----------------------------------------------------------------
  philosophy: {
    searchTerms: [
      'philosopher born',
      'philosopher died',
      'Stoic letter',
      'Eastern philosophy',
      'Zen koan',
      'thought experiment',
      'philosophical publication',
      'academic debate',
    ],
    categoryFilters: [
      'Western philosophers',
      'Eastern philosophers',
      'Stoic letters',
      'Buddhist teachings',
      'Existentialist works',
      'philosophical paradoxes',
      'thought experiments',
    ],
    dateWindow: 'this day',
    directive:
      'For this calendar date, query the philosophical record for: (1) famous philosophers born or who died on this day, (2) landmark philosophical publications released on this day, (3) Stoic letters and Eastern philosophy quotes pulled from a structured dataset of canonical letters/meditations/koans, (4) thought experiments or major academic debates first recorded on this day. Cover both Eastern and Western traditions — Stoicism, Nihilism, Zen Buddhism, Existentialism, Legalism. Pull the 8 results from a mix of thought experiments, lifecycles of major thinkers, and ethical paradoxes.',
    structuredHint:
      'When filtering for the single most viral event, prioritize events that translate cleanly into a thought-provoking question or paradox the audience can debate in the comments — a "what would YOU do?" payload beats a dry date announcement.',
  },

  // -----------------------------------------------------------------
  // 4) 'unsolved_earth' — archaeology, astronomy, monolith milestones.
  //    dateWindow includes "this day and the surrounding week" so the
  //    model can fall back to nearby-week discoveries on quiet days.
  // -----------------------------------------------------------------
  unsolved_earth: {
    searchTerms: [
      'archaeological discovery',
      'astronomical anomaly',
      'monolith milestone',
      'megalithic site',
      'ancient excavation',
      'artifact recovery',
      'cosmic alignment',
      'unexplained phenomenon',
    ],
    categoryFilters: [
      'archaeology',
      'astronomy',
      'megalithic structures',
      'ancient anomalies',
      'lost civilizations',
      'undeciphered scripts',
    ],
    dateWindow: 'this day and the surrounding week',
    directive:
      'For this calendar date AND the surrounding week in history, filter for: archaeological discoveries, astronomical anomalies, monolith milestones, megalithic site excavations, artifact recoveries, and unexplained phenomena. Use the search terms "archaeological discovery", "astronomical anomaly", and "monolith milestone" as your filter vocabulary. If the exact day has no major discovery, expand to the same week in any year to surface the strongest anomalous event — Gobekli Tepe-style scale, Antikythera-style artifacts, or cosmic-alignment events at ancient sites.',
    structuredHint:
      'When filtering for the single most viral event, prioritize events that retain a strong "unsolved question" — competing theories, scale-of-engineering mysteries, or cosmic alignments — over resolved historical finds.',
  },

  // -----------------------------------------------------------------
  // 5) 'vintage_tech' — console release dates, software drops,
  //    tech patents recorded on this day.
  // -----------------------------------------------------------------
  vintage_tech: {
    searchTerms: [
      'console release',
      'software version',
      'tech patent',
      'hardware launch',
      'OS release',
      'gadget release',
      'firmware drop',
      'tech demo',
    ],
    categoryFilters: [
      'gaming consoles',
      'personal computers',
      'iconic software',
      'patents filed',
      'patents granted',
      'product launches',
      'firmware milestones',
    ],
    dateWindow: 'this day',
    directive:
      'For this calendar date, query technology history databases for: console release dates, iconic software version drops, hardware product launches, foundational patents filed or granted on this day, OS releases, and quirky forgotten gadgets introduced on this day. Use the search terms "console release", "software version", and "tech patent" as your filter vocabulary. Range from the 1950s mainframe era through the early-2000s internet/cyber era — emphasize nostalgia, tactile product design, and the engineering constraints of the time.',
    structuredHint:
      'When filtering for the single most viral event, prioritize events with strong nostalgia, a recognizable product the audience has actually held, or a vivid "tech was smaller back then" framing.',
  },

  // -----------------------------------------------------------------
  // 6) 'conspiracy' — declassified files, CIA, Project Blue Book,
  //    MKUltra, infamous unproven events.
  // -----------------------------------------------------------------
  conspiracy: {
    searchTerms: [
      'declassified files',
      'CIA documents',
      'Project Blue Book',
      'MKUltra',
      'FBI files',
      'cryptid sighting',
      'government cover-up',
      'unproven event',
    ],
    categoryFilters: [
      'declassified documents',
      'government programs',
      'cryptid encounters',
      'unexplained phenomena',
      'alternative theories',
    ],
    dateWindow: 'this day and the surrounding week',
    directive:
      'For this calendar date AND the surrounding week in history, query declassified archives, intelligence-community releases, and famous unproven-event logs for: declassified CIA documents, Project Blue Book sightings, MKUltra activities, FBI file releases, government cover-ups, cryptid encounters, and infamous unproven events that align chronologically with this date. Use "declassified files", "CIA documents", and "Project Blue Book logs" as your primary filter vocabulary. Avoid modern political disinformation and hate-speech-related theories — stay educational, historical, and mysterious.',
    structuredHint:
      'When filtering for the single most viral event, prioritize events that have a tangible artifact — a redacted document, a sighting report, a recorded memo — and a lingering alternative theory that survives scrutiny.',
  },

  // -----------------------------------------------------------------
  // 7) 'women' — women's history. Per the spec, fill in the relevant
  //    query details for this niche on this day.
  //    Pulls from women's rights milestones, suffrage movements,
  //    barrier-breaking firsts, scientific breakthroughs by female
  //    pioneers, and reproductive/labor/education wins.
  // -----------------------------------------------------------------
  women: {
    searchTerms: [
      "women's rights",
      'suffrage',
      'suffragette',
      'first woman',
      'female pioneer',
      'glass ceiling',
      'barrier-breaking',
      "women's labor",
      "women's education",
      'reproductive rights',
      'feminist movement',
      'women in science',
      'women in politics',
      'women in sport',
      'women in aviation',
    ],
    categoryFilters: [
      "women's rights milestones",
      'female pioneers',
      'scientific breakthroughs by women',
      'political firsts by women',
      'suffrage and suffragette movements',
      'reproductive rights rulings',
      "women's labor history",
      "women's education access",
      'feminist publications and manifestos',
      'women in wartime',
    ],
    dateWindow: 'this day',
    directive:
      "For this calendar date, query women's history for: barrier-breaking firsts (first woman elected/admitted/sworn in/first to fly/sail/command X), suffrage and suffragette milestones (votes granted, marches, arrests of activists), reproductive rights rulings and wins, female scientific and cultural pioneers, women's labor and education access victories, feminist publications and manifestos, and political/legal firsts by women. Use the search terms \"women's rights\", \"suffrage\", \"first woman\", \"female pioneer\", \"glass ceiling\", and \"reproductive rights\" as your filter vocabulary. Pull the 8 events from a global and historical range of fields — science, literature, politics, aviation, sport, philosophy, and social movements. Bias toward deep, concrete, high-impact achievements over trivial celebrity or pop-culture anniversaries.",
    structuredHint:
      "When filtering for the single most viral event, prioritize events that feel like a real, hard-won breakthrough — a legal right earned, a ceiling shattered, a discovery credited — over soft 'first to be photographed' style entries.",
  },
};

// ---------------------------------------------------------------------
// Factory — the only export the endpoints need.
// ---------------------------------------------------------------------

/**
 * Build a query context for the given niche id and calendar date.
 * Always returns a populated object — unknown / null / empty / non-
 * string ids all fall back to the 'history' context.
 *
 * The factory reuses `resolveNicheProfile` to normalize the incoming
 * id (case-insensitive, alias-aware, snake_case ↔ kebab_case), so
 * every frontend id resolves to the right query context without
 * duplicating the alias table here.
 *
 * @param {*}       nicheId      The active_niche string from the
 *                               request body, or null/undefined.
 * @param {string}  currentDate  Human-readable date (e.g. "January 7").
 *                               Inlined into the directive so the LLM
 *                               sees the calendar context with the
 *                               query brief.
 * @returns {object}             Frozen context with { id, label,
 *                               searchTerms, categoryFilters,
 *                               dateWindow, directive,
 *                               structuredHint }.
 */
export function buildNicheQuery(nicheId, currentDate) {
  // Defensive: any non-string input (null, undefined, number, object)
  // skips the string lookups and falls straight to the default
  // query context — same contract as resolveNicheProfile.
  const profile = resolveNicheProfile(nicheId);
  const id = profile.id;

  const base = NICHE_QUERIES[id] || NICHE_QUERIES[DEFAULT_QUERY_ID];

  // Stamp the date into the directive so the LLM sees the calendar
  // context inline with the query instructions. We build the final
  // string here (not at module load) so it always reflects the
  // current request's date — the LLM does NOT receive a stale
  // "January 7" directive on a different day.
  const dateStampedDirective = currentDate && typeof currentDate === 'string'
    ? `${base.directive} (Target date: ${currentDate}.)`
    : base.directive;

  return Object.freeze({
    id,
    label: profile.label,
    // Clone the arrays so a downstream consumer cannot mutate the
    // shared registry. searchTerms / categoryFilters are read-only
    // for the lifetime of the request.
    searchTerms: [...base.searchTerms],
    categoryFilters: [...base.categoryFilters],
    dateWindow: base.dateWindow,
    directive: dateStampedDirective,
    structuredHint: base.structuredHint || '',
  });
}
