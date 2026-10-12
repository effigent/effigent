// mockbackend stands in for the log backend: it accepts effigentd's batched
// POSTs, checks the bearer token, and appends every event to a JSONL file.
package main

import (
	"encoding/json"
	"flag"
	"log"
	"net/http"
	"os"
)

func main() {
	addr := flag.String("listen", "127.0.0.1:9999", "listen address")
	out := flag.String("out", "backend-events.jsonl", "where received events are appended")
	token := flag.String("token", "", "required bearer token")
	flag.Parse()
	f, err := os.OpenFile(*out, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		log.Fatal(err)
	}
	http.HandleFunc("POST /ingest", func(w http.ResponseWriter, r *http.Request) {
		if *token != "" && r.Header.Get("Authorization") != "Bearer "+*token {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		var body struct {
			Events []json.RawMessage `json:"events"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		for _, e := range body.Events {
			f.Write(append(e, '\n'))
		}
		log.Printf("received batch of %d events", len(body.Events))
	})
	log.Fatal(http.ListenAndServe(*addr, nil))
}
