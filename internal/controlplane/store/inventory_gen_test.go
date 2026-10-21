package store

import (
	"os"
	"strings"
	"testing"
)

// backfillEvents is what migration 016 reads instead of one batch.
const backfillEvents = `(select * from cp.events where event_time >= now() - interval '35 days')`

func squash(s string) string { return strings.Join(strings.Fields(s), " ") }

// TestInventoryBackfillInStep: migration 016's backfill runs the same
// statements as IngestBatch, over the last 35 days instead of one batch.
func TestInventoryBackfillInStep(t *testing.T) {
	raw, err := os.ReadFile("migrations/016_inventory.sql")
	if err != nil {
		t.Fatal(err)
	}
	mig := squash(string(raw))
	for _, q := range inventoryRollups {
		want := squash(strings.ReplaceAll(q, batchEvents, backfillEvents)) + ";"
		if !strings.Contains(mig, want) {
			t.Errorf("migration 016 doesn't run this rollup as IngestBatch does:\n%s", want)
		}
	}
}
