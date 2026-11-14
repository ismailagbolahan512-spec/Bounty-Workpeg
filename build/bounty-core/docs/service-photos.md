# Service discovery photos

The service discovery page (`#/services/discover`) shows one photographic strip per
industry. Each strip loads `public/photos/services/<industry key>.jpg`. If a file is
missing, the strip keeps a tonal panel, so the page works without photos.

## Files

| Industry key | File |
| --- | --- |
| hotel | `photos/services/hotel.jpg` |
| short_let | `photos/services/short_let.jpg` |
| restaurant | `photos/services/restaurant.jpg` |
| bar_club | `photos/services/bar_club.jpg` |
| event_venue | `photos/services/event_venue.jpg` |
| catering | `photos/services/catering.jpg` |
| spa_wellness | `photos/services/spa_wellness.jpg` |
| other | `photos/services/other.jpg` (optional) |

## Specification

- Landscape, 4:3, at least 1200 × 900 px, under 300 KB after compression (JPEG, quality ~78).
- One person doing the work, in the real setting, with the task visible.
- Natural daylight or practical light only. No heavy filters, no duotone, no stock poses.
- The subject is not centred in the strip; leave room on the left for the crop to breathe.
- No text, logos, or identifiable customer faces in frame.

## Where the photos come from

1. Commissioned shoot (preferred, matches the art direction). One half-day per category
   in a real hotel, kitchen or venue, with the people who do the work, released for use.
2. Licensed library. Check each photo's licence before use.
3. Unsplash, as a stop-gap. Unsplash photos can be used without attribution under the
   Unsplash License, but the API terms require hotlinking and attribution, so download
   the file from the website and keep a local copy. Avoid generic corporate stock.

Record the source and licence of each file in `docs/service-photos-credits.md` before
the site goes live.
