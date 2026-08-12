# product-board
A collaborative assortment board. Products live in a catalog with images. Users arrange them on an infinite canvas board, panning, zooming, selecting, and dragging tiles. Positions persist.

## Testing

> **Heads up:** root `pnpm test` runs *every* package — `api`'s Vitest **and**
> `web`'s `ng test` (Karma), which launches a browser and may hang in a headless
> shell. To run just the API suite:
>
> ```bash
> pnpm --filter @assortment/api test
> ```
>
> TODO: switch Angular's test runner to headless Chrome so root `pnpm test` is
> CI-safe.
