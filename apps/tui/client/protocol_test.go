package client

import "testing"

func TestAProtocolMismatchNamesBothReleasesAndTheFix(t *testing.T) {
	session := &protocolSession{endpoint: "http://127.0.0.1:3434"}
	for _, test := range []struct{ refusal, want string }{
		{
			"incompatible SuperTag protocol: this Gateway (SuperTag 0.3.0) speaks protocol versions [2], but the connecting operator client (SuperTag 0.3.1) offered [3]; run the same SuperTag release on both services",
			"This TUI speaks SuperTag protocol 7, but the Gateway at http://127.0.0.1:3434 runs SuperTag 0.3.0 (protocol 2). Upgrade the Gateway.",
		},
		{
			"incompatible SuperTag protocol: this Gateway (SuperTag 0.5.0) speaks protocol versions [8, 9], but ...",
			"This TUI speaks SuperTag protocol 7, but the Gateway at http://127.0.0.1:3434 runs SuperTag 0.5.0 (protocols 8, 9). Upgrade this TUI.",
		},
		{
			"incompatible SuperTag protocol: no\x07pe.",
			"This TUI speaks SuperTag protocol 7, but the Gateway at http://127.0.0.1:3434 refused it: incompatible SuperTag protocol: nope. Run the same SuperTag release on both.",
		},
	} {
		err := session.mismatch(parseRefusal(test.refusal))
		if !ProtocolMismatch(err) || err.Error() != test.want {
			t.Errorf("mismatch(%q) = %v", test.refusal, err)
		}
	}
}
