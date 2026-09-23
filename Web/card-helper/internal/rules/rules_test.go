package rules

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

// Every case in testdata/typescript.json is validateFormatRequest's own answer, generated from
// the dashboard's schema. Matching it word for word is the claim that the helper and the page
// agree on what a format request may be.
func TestMatchesTheSchema(t *testing.T) {
	raw, err := os.ReadFile("testdata/typescript.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		AllocationUnitBytes int64    `json:"allocationUnitBytes"`
		Label               string   `json:"label"`
		Problems            []string `json:"problems"`
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		got := ValidateFormat(c.AllocationUnitBytes, c.Label)
		if len(got) == 0 && len(c.Problems) == 0 {
			continue
		}
		if !reflect.DeepEqual(got, c.Problems) {
			t.Errorf("%d %q: helper says %q, schema says %q", c.AllocationUnitBytes, c.Label, got, c.Problems)
		}
	}
}
