package config

import (
	"github.com/BurntSushi/toml"
)

type Config struct {
	ListenAddress string `toml:"listen_address"`
	CorsEndpoint  string `toml:"cors_endpoint"`
}

func NewConfig(filePath string) (*Config, error) {
	config := &Config{}
	_, err := toml.DecodeFile(filePath, config)

	return config, err
}
