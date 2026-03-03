package config

import (
	"github.com/BurntSushi/toml"
)

type ICEServer struct {
	URLs       []string `json:"urls" toml:"urls"`
	Username   string   `json:"username,omitempty" toml:"username"`
	Credential string   `json:"credential,omitempty" toml:"credential"`
}

type Config struct {
	ListenAddress string `toml:"listen_address"`
	CorsEndpoint  string `toml:"cors_endpoint"`
	TurnRealm     string `toml:"turn_realm"`
	TurnListenIP  string `toml:"turn_listen_ip"`
	PublicIP      string `toml:"public_ip"`
	TurnPort      int    `toml:"turn_port"`

	UseExternalTurn        bool        `toml:"use_external_turn"`
	ExternalICEServers     []ICEServer `toml:"external_ice_servers"`
	CloudflareTurnKeyID    string      `toml:"cloudflare_turn_key_id"`
	CloudflareTurnAPIToken string      `toml:"cloudflare_turn_api_token"`
}

func NewConfig(filePath string) (*Config, error) {
	config := &Config{}
	_, err := toml.DecodeFile(filePath, config)

	return config, err
}
