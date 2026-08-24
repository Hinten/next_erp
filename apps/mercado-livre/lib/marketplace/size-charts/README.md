# size-charts — grades de tamanho

ML's size-chart catalog: choosing a chart at publish time and keeping the
seller's charts in sync.

- `sizeChart.ts` — pure chart selection and row matching at publish time.
  Consumed by `anuncios/publish.ts` and `anuncios/publishCore.ts`.
- `sizeChartSync.ts` — chart CRUD sync to ML, per integração.
- `sizeChartDelete.ts` — the `DELETE /catalog/charts/{id}` half of the CRUD.
