package main

import (
	"github.com/gargakshit/kabootar/signalling/config"
	"github.com/gargakshit/kabootar/signalling/web"
)

func main() {
	cfg, err := config.NewConfig("kabootar.toml")
	if err != nil {
		panic(err)
	}

	err = web.InitWeb(cfg)
	if err != nil {
		panic(err)
	}
}
