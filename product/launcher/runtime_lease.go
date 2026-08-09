package main

type RuntimeLease interface {
	RootPath() string
	VerifyEntrypoint(string) error
	Close() error
}
