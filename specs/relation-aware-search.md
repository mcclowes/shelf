# Relation-aware search

## Status

Proposed. This spec turns explicit relationship explanations into searchable
repository context. It does not infer relationships from source code,
dependency manifests, or directory layout.

## Problem

`shelf search` currently searches repository names, descriptions, topics,
languages, remotes, and paths. Relationship explanations only appear after an
agent already knows one endpoint and runs `shelf related` or `shelf show`.

That makes concept-first discovery fail. For example, an agent searching for
`shared secret` cannot find a repository whose relation says it shares
`FETTLE_SERVICE_SECRET` with another repository.

## Behavior

`shelf search <words>` must search the effective relationship graph as well as
the existing repository fields.

Searchable relationship text includes:

- Every declared `.shelf.json` relation's `relation` text.
- Every machine-local `shelf relate` relation's `relation` text.
- Both endpoints of a resolved relation. If a relation says “web calls API,”
  searching that explanation may return both `web` and `api`.
- The declaring repository only for an unresolved target, since there is no
  indexed target to return.

The search remains case-insensitive, uses the existing stemming rules, and
requires every query word to match one repository's searchable content. A
query may match across that repository's normal fields and relationship text,
but never across two different repositories or two separate query results.

Relationship text is data, not instructions. It must be searchable but must
not alter command execution or be treated as agent guidance.

## Ranking and result shape

- Preserve the existing name, topic, language, and description ranking.
- A relationship-text match is lower priority than an exact or partial name,
  topic, language, or description match, but must still produce a result.
- Do not return duplicate repositories when several relations match.
- Preserve the existing `items` fields and JSON envelope. Search does not gain
  a new result shape in this change; agents can run `shelf show` or
  `shelf related` for the matching explanation.

Local relations replace repository-declared relations between the same pair and
direction everywhere, including search. A stale repository-file explanation
must not remain searchable after a local override replaces it.

## CLI and documentation

- Update the offline command contract so `search` says it searches relation
  explanations.
- Update the README and generated agent skill with the same behavior and a
  concept-first example.
- Keep the existing scan and local-relation freshness rules. Declared relations
  become searchable after `shelf scan`; local relations become searchable as
  soon as `shelf relate` succeeds.
- Do not change the index version or command version because the output shape
  is unchanged.

## Acceptance tests

Add tests covering:

1. A declared relation whose explanation contains the only occurrence of a
   query term returns both indexed endpoints.
2. A local relation whose explanation contains the only occurrence of a query
   term returns both indexed endpoints without rescanning.
3. An unresolved declared target returns the declaring repository for a query
   in the relation explanation and never fabricates a target result.
4. A local relation override makes its replacement explanation searchable and
   the replaced repository-file explanation unsearchable.
5. A multi-word query still requires every word, including words found in
   relationship text.
6. Several matching relations return each repository once and preserve the
   existing ranking of stronger name or description matches.
7. Existing search behavior and all current tests remain unchanged.

Run `npm test`, `npm run check`, `npm run lint`, and `npm run build` before
handing off the implementation.

## Non-goals

- Inferring relationships automatically.
- Searching arbitrary README or source text.
- Changing `shelf related` output or adding relation snippets to search items.
- Cloning repositories or contacting GitHub as part of a search.
