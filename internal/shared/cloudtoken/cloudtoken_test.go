package cloudtoken

import "testing"

func TestRoundTrip(t *testing.T) {
	in := Token{Server: "https://api.effigent.ai/", EndpointID: "e1", Tenant: "org:x", Secret: "eps_s", ServerPublicKey: "pk"}
	s := Encode(in)
	out, err := Decode(" " + s + "\n")
	if err != nil {
		t.Fatal(err)
	}
	in.Server = "https://api.effigent.ai"
	if out != in {
		t.Fatalf("%+v", out)
	}
	for _, bad := range []string{"", "eft_abc", "efc_!!!", Encode(Token{Server: "x"}), "efc_" + "e30"} {
		if _, err := Decode(bad); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
}
