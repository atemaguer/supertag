module github.com/atemaguer/supertag/packages/operator-api/go

go 1.26.0

require (
	connectrpc.com/connect v1.21.1
	google.golang.org/protobuf v1.36.12
)

tool (
	connectrpc.com/connect/cmd/protoc-gen-connect-go
	google.golang.org/protobuf/cmd/protoc-gen-go
)
