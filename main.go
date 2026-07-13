package main

import (
	"context"
	"embed"
	"os"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/linux"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	// WebKitGTK under the Wayland backend on wlroots (Hyprland) reports
	// devicePixelRatio = 1/96, shrinking the whole UI ~96x. The X11 (XWayland)
	// backend reports the correct DPR, so force it before GTK initializes.
	if os.Getenv("GDK_BACKEND") == "" {
		os.Setenv("GDK_BACKEND", "x11")
	}

	// Create an instance of the app structure
	app := NewApp()

	// Create application with options
	err := wails.Run(&options.App{
		Title:     "Displays",
		Width:     980,
		Height:    700,
		Frameless: true,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		BackgroundColour: &options.RGBA{R: 7, G: 8, B: 9, A: 1},
		OnStartup:        app.startup,
		// Closing the window (Esc) with an unconfirmed Apply pending must not
		// leave that layout live — revert first, then allow the close.
		OnBeforeClose: func(ctx context.Context) bool {
			app.revertIfPending()
			return false
		},
		Linux: &linux.Options{
			// Wails defaults to WebviewGpuPolicyNever when Linux options are
			// absent (wails#2977) — pure software rasterization, so paint cost
			// grows with window area and fullscreen lags. Force GPU compositing;
			// if NVIDIA/XWayland artifacts show up, fall back to Never and set
			// WEBKIT_DISABLE_DMABUF_RENDERER=1 instead.
			WebviewGpuPolicy: linux.WebviewGpuPolicyAlways,
			ProgramName:      "displays",
		},
		Bind: []interface{}{
			app,
		},
	})

	if err != nil {
		println("Error:", err.Error())
	}
}
