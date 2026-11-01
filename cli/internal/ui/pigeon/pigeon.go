// Package pigeon draws Kabootar's logo in the terminal in full colour, two
// pixels per character cell ("▀" with separate foreground and background),
// and animates it flying the way the web app's logo does.
package pigeon

//go:generate go run gen.go

import (
	"bytes"
	_ "embed"
	"fmt"
	"image"
	"image/png"
	"math"
	"strings"
	"sync"
)

//go:embed pigeon.png
var pigeonPNG []byte

var (
	srcOnce sync.Once
	src     *image.NRGBA
)

func source() *image.NRGBA {
	srcOnce.Do(func() {
		img, err := png.Decode(bytes.NewReader(pigeonPNG))
		if err != nil {
			panic(err)
		}
		if n, ok := img.(*image.NRGBA); ok {
			src = n
			return
		}
		b := img.Bounds()
		src = image.NewNRGBA(b)
		for y := b.Min.Y; y < b.Max.Y; y++ {
			for x := b.Min.X; x < b.Max.X; x++ {
				src.Set(x, y, img.At(x, y))
			}
		}
	})
	return src
}

// Colour depth of the terminal.
type Mode int

const (
	TrueColor Mode = iota
	Color256
)

type rgba struct{ r, g, b, a float64 }

// sample reads the logo at normalised coordinates with bilinear filtering,
// in premultiplied alpha.
func sample(u, v float64) rgba {
	img := source()
	w, h := img.Bounds().Dx(), img.Bounds().Dy()
	x, y := u*float64(w)-0.5, v*float64(h)-0.5
	x0, y0 := int(math.Floor(x)), int(math.Floor(y))
	fx, fy := x-float64(x0), y-float64(y0)
	at := func(px, py int) rgba {
		if px < 0 || py < 0 || px >= w || py >= h {
			return rgba{}
		}
		i := img.PixOffset(px, py)
		a := float64(img.Pix[i+3]) / 255
		return rgba{float64(img.Pix[i]) * a, float64(img.Pix[i+1]) * a, float64(img.Pix[i+2]) * a, a}
	}
	mix := func(p, q rgba, t float64) rgba {
		return rgba{p.r + (q.r-p.r)*t, p.g + (q.g-p.g)*t, p.b + (q.b-p.b)*t, p.a + (q.a-p.a)*t}
	}
	return mix(mix(at(x0, y0), at(x0+1, y0), fx), mix(at(x0, y0+1), at(x0+1, y0+1), fx), fy)
}

// Pose is one moment of the flight cycle.
type Pose struct {
	Lift   float64 // vertical offset, fraction of height (negative is up)
	Tilt   float64 // rotation in degrees
	Squash float64 // vertical scale
	Wings  float64 // 1 = wings fully raised, ~0.3 = folded down
}

// PoseAt follows the web app's kb-fly keyframes (bob and tilt) and adds a
// wingbeat, for phase in [0, 1).
func PoseAt(phase float64) Pose {
	// ease-in-out between the 0% and 50% keyframes, and back.
	t := (1 - math.Cos(phase*2*math.Pi)) / 2
	return Pose{
		Lift:   -0.04 * t,
		Tilt:   -3 + 5*t,
		Squash: 1 - 0.04*t,
		Wings:  1 - 0.5*t,
	}
}

// Shoulder line, and where the wings end, in normalised logo coordinates.
const (
	shoulderX, shoulderY = 0.62, 0.58
	wingEdge0, wingEdge1 = 0.58, 0.78
)

// Where the eye is in the logo, in normalised coordinates.
const eyeX, eyeY, eyeR = 0.883, 0.52, 0.016

// eyeSamples is how many of a cell's samples must land on the eye for the
// cell to be drawn as the eye.
const eyeSamples = 4

// pixel returns the colour at normalised canvas coordinates for a pose, and
// whether that point is the eye.
func pixel(p Pose, u, v float64) (rgba, bool) {
	// Undo the CSS transform: origin 51% 94%, then translate, rotate, scale.
	const ox, oy = 0.51, 0.94
	x, y := u-ox, v-oy-p.Lift
	th := -p.Tilt * math.Pi / 180
	x, y = x*math.Cos(th)-y*math.Sin(th), x*math.Sin(th)+y*math.Cos(th)
	y /= p.Squash
	x, y = x+ox, y+oy

	// Undo the wingbeat: everything above the shoulder and left of the
	// head was folded towards the shoulder line by Wings.
	if y < shoulderY {
		w := 1.0
		if x > wingEdge0 {
			w = math.Max(0, 1-(x-wingEdge0)/(wingEdge1-wingEdge0))
		}
		k := 1 - (1-p.Wings)*w
		y = shoulderY - (shoulderY-y)/k
		// Folding also swings the wingtips back a little.
		x += (1 - k) * 0.12 * (shoulderY - y)
	}
	eye := math.Hypot(x-eyeX, (y-eyeY)*1.05) < eyeR
	return sample(x, y), eye
}

// Frame is a rendered picture: one string per terminal row, each Width
// cells wide.
type Frame struct {
	Rows  []string
	Width int
}

// cell is what one character cell covers: a 2×4 grid of sub-blocks (to
// pick a glyph whose shape matches) plus the cell's overall colour.
type cell struct {
	ink   [8]float64 // coverage × brightness per sub-block, rows top to bottom
	avg   rgba
	dark  rgba    // darkest covered sample, for the eye
	darkL float64 // its luminance
	meanL float64 // mean luminance of covered samples
	eye   int     // samples that fall on the eye
}

// cells renders a pose: pw×rows cells. Cells are about twice as tall as
// wide.
func cells(p Pose, rows int) ([]cell, int) {
	img := source()
	aspect := float64(img.Bounds().Dx()) / float64(img.Bounds().Dy())
	// Margins for the bob and the rotation, in logo widths/heights.
	const padT, padB, padL, padR = 0.07, 0.05, 0.02, 0.05
	spanV, spanU := 1+padT+padB, 1+padL+padR
	pw := int(math.Round(float64(rows*2) / spanV * aspect * spanU))
	out := make([]cell, pw*rows)
	const sx, sy = 4, 8 // samples per cell; each sub-block is 2×2 samples
	for y := range rows {
		for x := range pw {
			var c cell
			var sub [8]rgba
			var lumSum, covSum float64
			c.darkL = 2
			for j := range sy {
				for i := range sx {
					u := (float64(x)+(float64(i)+0.5)/sx)/float64(pw)*spanU - padL
					v := (float64(y)+(float64(j)+0.5)/sy)/float64(rows)*spanV - padT
					px, eye := pixel(p, u, v)
					if eye {
						c.eye++
					}
					k := (j/2)*2 + i/2
					sub[k] = rgba{sub[k].r + px.r, sub[k].g + px.g, sub[k].b + px.b, sub[k].a + px.a}
					c.avg = rgba{c.avg.r + px.r, c.avg.g + px.g, c.avg.b + px.b, c.avg.a + px.a}
					if px.a > 0.6 {
						l := lum(px)
						lumSum += l * px.a
						covSum += px.a
						if l < c.darkL {
							c.darkL, c.dark = l, px
						}
					}
				}
			}
			n := float64(sx * sy)
			c.avg = rgba{c.avg.r / n, c.avg.g / n, c.avg.b / n, c.avg.a / n}
			if covSum > 0 {
				c.meanL = lumSum / covSum
			}
			for k, b := range sub {
				b = rgba{b.r / 4, b.g / 4, b.b / 4, b.a / 4}
				c.ink[k] = math.Min(1, b.a) * (0.55 + 0.45*lum(b))
			}
			out[y*pw+x] = c
		}
	}
	return out, pw
}

// lum is the relative luminance (0–1) of a premultiplied pixel.
func lum(c rgba) float64 {
	if c.a <= 0 {
		return 0
	}
	return (0.2126*c.r + 0.7152*c.g + 0.0722*c.b) / 255 / c.a
}

// Render draws the pigeon in a pose, rows terminal rows tall.
func Render(p Pose, rows int, mode Mode) Frame {
	cs, pw := cells(p, rows)
	f := Frame{Width: pw}
	for row := range rows {
		var sb strings.Builder
		last := ""
		for x := range pw {
			c := cs[row*pw+x]
			ch, col := Glyph(c)
			if ch == ' ' {
				sb.WriteByte(' ')
				continue
			}
			if c.eye >= eyeSamples {
				// A dark pupil on a patch of the head's colour, so the eye
				// shows even though the terminal behind it is dark.
				sb.WriteString("\033[38;" + code(col, mode) + ";48;" + code(visible(c.avg), mode) + "m")
				sb.WriteByte(ch)
				sb.WriteString("\033[0m")
				last = ""
				continue
			}
			if code := code(col, mode); code != last {
				sb.WriteString("\033[38;" + code + "m")
				last = code
			}
			sb.WriteByte(ch)
		}
		if last != "" {
			sb.WriteString("\033[0m")
		}
		f.Rows = append(f.Rows, sb.String())
	}
	return f
}

// glyphs maps characters to the ink they put in each 2×4 sub-block of a
// cell (rows top to bottom, left then right). Matching a cell against these
// keeps edges crisp (/ \ _ ( ) …) while the inside gets dense characters.
var glyphs = []struct {
	ch   byte
	mask [8]float64
}{
	{'.', [8]float64{0, 0, 0, 0, 0, 0, .35, .35}},
	{'_', [8]float64{0, 0, 0, 0, 0, 0, .9, .9}},
	{'-', [8]float64{0, 0, .35, .35, .35, .35, 0, 0}},
	{'=', [8]float64{0, 0, .7, .7, .7, .7, 0, 0}},
	{'\'', [8]float64{.35, .35, 0, 0, 0, 0, 0, 0}},
	{'"', [8]float64{.7, .7, .2, .2, 0, 0, 0, 0}},
	{'^', [8]float64{.5, .5, .3, .3, 0, 0, 0, 0}},
	{':', [8]float64{0, 0, .35, .35, 0, 0, .35, .35}},
	{'/', [8]float64{0, .7, .2, .5, .5, .2, .7, 0}},
	{'\\', [8]float64{.7, 0, .5, .2, .2, .5, 0, .7}},
	{'(', [8]float64{0, .6, .6, 0, .6, 0, 0, .6}},
	{')', [8]float64{.6, 0, 0, .6, 0, .6, .6, 0}},
	{'>', [8]float64{.5, 0, .2, .6, .2, .6, .5, 0}},
	{'L', [8]float64{.6, 0, .6, 0, .6, 0, .9, .9}},
	{'J', [8]float64{0, .6, 0, .6, 0, .6, .9, .9}},
	{'7', [8]float64{.9, .9, 0, .6, 0, .6, 0, .6}},
	{'r', [8]float64{0, 0, .7, .7, .7, 0, .7, 0}},
	{'d', [8]float64{0, .7, .5, .9, .9, .9, .9, .9}},
	{'b', [8]float64{.7, 0, .9, .5, .9, .9, .9, .9}},
	{'p', [8]float64{.9, .9, .9, .9, .9, .5, .7, 0}},
	{'q', [8]float64{.9, .9, .9, .9, .5, .9, 0, .7}},
	{'P', [8]float64{1, 1, 1, .8, .8, 0, .6, 0}},
	{'o', [8]float64{0, 0, .5, .5, .6, .6, .3, .3}},
	{'a', [8]float64{0, 0, .6, .6, .8, .8, .7, .7}},
	{'m', [8]float64{0, 0, .9, .9, .9, .9, .9, .9}},
	// Even, increasingly dense fills for the inside of the bird.
	{'*', uniform(.3)},
	{'O', uniform(.5)},
	{'0', uniform(.6)},
	{'8', uniform(.68)},
	{'#', uniform(.76)},
	{'B', uniform(.83)},
	{'@', uniform(.9)},
	{'M', uniform(.97)},
}

func uniform(v float64) [8]float64 { return [8]float64{v, v, v, v, v, v, v, v} }

// Glyph picks the character for a cell and the colour to draw it in.
func Glyph(c cell) (byte, rgba) {
	var total float64
	for _, v := range c.ink {
		total += v
	}
	if total/8 < 0.05 {
		return ' ', rgba{}
	}
	if c.eye >= eyeSamples {
		return 'o', rgba{14, 12, 34, 1}
	}
	best, bestD := byte(' '), math.Inf(1)
	for _, g := range glyphs {
		var d float64
		for k := range 8 {
			e := c.ink[k] - g.mask[k]
			d += e * e
		}
		if d < bestD {
			best, bestD = g.ch, d
		}
	}
	return best, visible(c.avg)
}

// code is the SGR colour parameter (after "38;" or "48;") for a pixel.
func code(c rgba, mode Mode) string {
	r, g, b := unpremul(c)
	if mode == TrueColor {
		return fmt.Sprintf("2;%d;%d;%d", r, g, b)
	}
	return fmt.Sprintf("5;%d", xterm256(r, g, b))
}

func unpremul(c rgba) (r, g, b uint8) {
	if c.a == 0 {
		return 0, 0, 0
	}
	cl := func(v float64) uint8 { return uint8(math.Max(0, math.Min(255, math.Round(v/c.a)))) }
	return cl(c.r), cl(c.g), cl(c.b)
}

// visible brightens dark colours (keeping their hue) so the navy and violet
// feathers still show on a dark terminal. The eye is left dark.
func visible(c rgba) rgba {
	const floor = 0.42
	l := lum(c)
	if l <= 0.02 || l >= floor {
		return c
	}
	k := math.Min(floor/l, 2.6)
	return rgba{c.r * k, c.g * k, c.b * k, c.a}
}

// xterm256 picks the nearest colour in the 6×6×6 cube or the grey ramp.
func xterm256(r, g, b uint8) int {
	levels := []int{0, 95, 135, 175, 215, 255}
	near := func(v uint8) int {
		best := 0
		for i, l := range levels {
			if abs(int(v)-l) < abs(int(v)-levels[best]) {
				best = i
			}
		}
		return best
	}
	ri, gi, bi := near(r), near(g), near(b)
	cube := 16 + 36*ri + 6*gi + bi
	dc := sq(int(r)-levels[ri]) + sq(int(g)-levels[gi]) + sq(int(b)-levels[bi])
	avg := (int(r) + int(g) + int(b)) / 3
	gi2 := max(0, min(23, (avg-8+5)/10))
	gv := 8 + gi2*10
	dg := sq(int(r)-gv) + sq(int(g)-gv) + sq(int(b)-gv)
	if dg < dc {
		return 232 + gi2
	}
	return cube
}

func abs(v int) int { return max(v, -v) }
func sq(v int) int  { return v * v }

// Animation caches the frames of one wingbeat at a size.
type Animation struct {
	Frames []Frame
	Rows   int
}

// NewAnimation renders n frames of the flight cycle, rows tall.
func NewAnimation(rows, n int, mode Mode) *Animation {
	a := &Animation{Rows: rows}
	for i := range n {
		a.Frames = append(a.Frames, Render(PoseAt(float64(i)/float64(n)), rows, mode))
	}
	return a
}
