//go:build ignore

// Downscales the web app's logo into the small image the terminal pigeon is
// drawn from. Run with `go generate ./...` after the logo changes.
package main

import (
	"image"
	"image/color"
	"image/png"
	"log"
	"os"
)

const width = 160

func main() {
	f, err := os.Open("../../../../public/assets/logo-mark.png")
	if err != nil {
		log.Fatal(err)
	}
	src, err := png.Decode(f)
	if err != nil {
		log.Fatal(err)
	}
	b := src.Bounds()
	height := b.Dy() * width / b.Dx()
	dst := image.NewNRGBA(image.Rect(0, 0, width, height))
	// Area average in premultiplied space, so transparent pixels don't
	// darken the edges.
	for y := range height {
		y0, y1 := b.Min.Y+y*b.Dy()/height, b.Min.Y+(y+1)*b.Dy()/height
		for x := range width {
			x0, x1 := b.Min.X+x*b.Dx()/width, b.Min.X+(x+1)*b.Dx()/width
			var r, g, bl, a, n uint64
			for sy := y0; sy < max(y1, y0+1); sy++ {
				for sx := x0; sx < max(x1, x0+1); sx++ {
					cr, cg, cb, ca := src.At(sx, sy).RGBA()
					r, g, bl, a, n = r+uint64(cr), g+uint64(cg), bl+uint64(cb), a+uint64(ca), n+1
				}
			}
			if a == 0 {
				continue
			}
			dst.SetNRGBA(x, y, color.NRGBA{
				R: uint8(r * 255 / a), G: uint8(g * 255 / a), B: uint8(bl * 255 / a),
				A: uint8(a / n >> 8),
			})
		}
	}
	out, err := os.Create("pigeon.png")
	if err != nil {
		log.Fatal(err)
	}
	defer out.Close()
	if err := png.Encode(out, dst); err != nil {
		log.Fatal(err)
	}
}
