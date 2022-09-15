package web

import "strconv"

type ProtoSMsg interface {
	Marshal() []string
}

type ProtoPMsg interface {
	Unmarshal(data []string)
}

const (
	ProtoSMJoined = iota
	ProtoSMLeft
	ProtoSMMsg
)

type ProtoSMJoinedPayload struct {
	ClientID string
}

func (p *ProtoSMJoinedPayload) Marshal() []string {
	return []string{strconv.Itoa(ProtoSMJoined), p.ClientID}
}

type ProtoSMLeftPayload struct {
	ClientID string
}

func (p *ProtoSMLeftPayload) Marshal() []string {
	return []string{strconv.Itoa(ProtoSMLeft), p.ClientID}
}

type ProtoSMMsgPayload struct {
	ClientID string
	Msg      string
}

func (p *ProtoSMMsgPayload) Marshal() []string {
	return []string{strconv.Itoa(ProtoSMMsg), p.ClientID, p.Msg}
}

const (
	ProtoMSMsg = iota
)

type ProtoMSMsgPayload struct {
	Msg string
}

func (p *ProtoMSMsgPayload) Unmarshal(data []string) {
	p.Msg = data[1]
}

const (
	ProtoSCMsg = iota
)

type ProtoSCMsgPayload struct {
	Msg string
}

func (p *ProtoSCMsgPayload) Marshal() []string {
	return []string{strconv.Itoa(ProtoSCMsg), p.Msg}
}

const (
	ProtoCSMsg = iota
)

type ProtoCSMsgPayload struct {
	Msg string
}

func (p *ProtoCSMsgPayload) Unmarshal(data []string) {
	p.Msg = data[1]
}
