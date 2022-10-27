package main

import (
	"fmt"

	"github.com/gargakshit/kabootar/signalling/config"
	"github.com/gargakshit/kabootar/signalling/web"
)

func main() {
	config, err := config.NewConfig("kabootar.toml")
	if err != nil {
		panic(err)
	}

	address := "0.0.0.0:5000"
	fmt.Println("Starting the server on", address)

	err = web.InitWeb(config.ListenAddress, config.CorsEndpoint)
	if err != nil {
		panic(err)
	}
}
