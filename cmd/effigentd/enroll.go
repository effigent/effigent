package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/effigent/effigent/internal/endpoint/cpclient"
)

// version is set at build time with -ldflags "-X main.version=…".
var version = "dev"

// enrollCmd implements `effigentd enroll --server URL --token TOKEN [--state-dir DIR]`.
func enrollCmd(args []string) {
	fs := flag.NewFlagSet("enroll", flag.ExitOnError)
	server := fs.String("server", "", "control plane URL, e.g. https://api.effigent.ai")
	token := fs.String("token", "", "one-time enrollment token from the console")
	dir := fs.String("state-dir", cpclient.DefaultStateDir(), "where to store this endpoint's credentials")
	_ = fs.Parse(args)
	if *server == "" || *token == "" {
		fs.Usage()
		os.Exit(2)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	st, err := cpclient.Enroll(ctx, *server, *token, *dir, version)
	if err != nil {
		fatalf("%v", err)
	}
	fmt.Printf("enrolled: endpoint %s (tenant %s)\ncredentials saved in %s\nstart the daemon: effigentd --state-dir %s\n",
		st.EndpointID, st.Tenant, *dir, *dir)
}
