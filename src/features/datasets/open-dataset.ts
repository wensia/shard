export const OPEN_DATASET_EVENT = "shard:open-dataset"

export function openDatasetEditor(path: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_DATASET_EVENT, { detail: { path } }))
}
