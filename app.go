package main

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// App is the Wails application backend. Every exported method is bound into the
// frontend at window.go.main.App.*.
type App struct {
	ctx context.Context
}

func NewApp() *App { return &App{} }

func (a *App) startup(ctx context.Context) { a.ctx = ctx }

// ---------- types exchanged with the frontend (json tags match Displays.html) ----------

type Mode struct {
	W     int   `json:"w"`
	H     int   `json:"h"`
	Rates []int `json:"rates"`
}

type Monitor struct {
	Name    string  `json:"name"`
	Make    string  `json:"make"`
	Model   string  `json:"model"`
	W       int     `json:"w"`
	H       int     `json:"h"`
	Rate    int     `json:"rate"`
	Scale   float64 `json:"scale"`
	X       int     `json:"x"`
	Y       int     `json:"y"`
	Active  bool    `json:"active"`
	Primary bool    `json:"primary"`
	Modes   []Mode  `json:"modes"`
}

// ---------- raw shape of `hyprctl monitors all -j` ----------

type hyprMonitor struct {
	Name           string   `json:"name"`
	Make           string   `json:"make"`
	Model          string   `json:"model"`
	Width          int      `json:"width"`
	Height         int      `json:"height"`
	RefreshRate    float64  `json:"refreshRate"`
	X              int      `json:"x"`
	Y              int      `json:"y"`
	Scale          float64  `json:"scale"`
	Disabled       bool     `json:"disabled"`
	Focused        bool     `json:"focused"`
	AvailableModes []string `json:"availableModes"`
}

// modeRe matches an availableModes entry like "2560x1600@240.00Hz".
var modeRe = regexp.MustCompile(`^(\d+)x(\d+)@([\d.]+)Hz$`)

// GetMonitors returns every output Hyprland knows about, including disabled
// ones (`all`), shaped for the frontend.
func (a *App) GetMonitors() ([]Monitor, error) {
	out, err := hyprctl("monitors", "all", "-j")
	if err != nil {
		return nil, err
	}
	var raw []hyprMonitor
	if err := json.Unmarshal([]byte(out), &raw); err != nil {
		return nil, fmt.Errorf("parse hyprctl monitors: %w", err)
	}

	mons := make([]Monitor, 0, len(raw))
	for _, r := range raw {
		modes := parseModes(r.AvailableModes)

		m := Monitor{
			Name:   r.Name,
			Make:   r.Make,
			Model:  r.Model,
			W:      r.Width,
			H:      r.Height,
			Rate:   int(math.Round(r.RefreshRate)),
			Scale:  r.Scale,
			X:      r.X,
			Y:      r.Y,
			Active: !r.Disabled,
			Modes:  modes,
		}

		// Disabled outputs report 0 geometry; fall back to the preferred
		// (highest) mode so the canvas can still draw the output.
		if (m.W == 0 || m.H == 0) && len(modes) > 0 {
			m.W, m.H = modes[0].W, modes[0].H
			if len(modes[0].Rates) > 0 {
				m.Rate = modes[0].Rates[0]
			}
		}
		if m.Scale == 0 {
			m.Scale = 1.0
		}
		mons = append(mons, m)
	}

	// Hyprland has no "primary" concept; by convention the output anchored at
	// the origin (0,0) is treated as primary so the badge stays meaningful.
	for i := range mons {
		if mons[i].Active && mons[i].X == 0 && mons[i].Y == 0 {
			mons[i].Primary = true
			break
		}
	}
	return mons, nil
}

// Apply pushes the layout to Hyprland live, persists it to monitors.lua, and
// returns the re-read state so the UI reflects any value Hyprland adjusted
// (e.g. an invalid scale snapped to a valid one).
//
// This Hyprland runs a Lua config (0.55), where `hyprctl keyword` is rejected
// ("keyword can't work with non-legacy parsers. Use eval."). So live changes go
// through `hyprctl eval 'hl.monitor({...})'` — the same call the config uses.
func (a *App) Apply(mons []Monitor) ([]Monitor, error) {
	for _, m := range mons {
		out, err := hyprctl("eval", monitorLua(m))
		if err != nil {
			return nil, fmt.Errorf("apply %s: %w", m.Name, err)
		}
		if strings.TrimSpace(out) != "ok" {
			return nil, fmt.Errorf("apply %s: hyprland rejected: %s", m.Name, out)
		}
	}

	if err := persist(mons); err != nil {
		return nil, fmt.Errorf("persist: %w", err)
	}
	return a.GetMonitors()
}

// ---------- helpers ----------

// monitorLua renders a single output as an hl.monitor() Lua call — used both for
// live `hyprctl eval` and for the persisted monitors.lua, so the two never drift.
func monitorLua(m Monitor) string {
	if m.Active {
		// `disabled = false` is required: hl.monitor() with only a mode does NOT
		// wake a previously-disabled output (it stays off), so re-enabling needs
		// the flag cleared explicitly.
		return fmt.Sprintf(`hl.monitor({ output = %q, disabled = false, mode = "%dx%d@%d", position = "%dx%d", scale = %s })`,
			m.Name, m.W, m.H, m.Rate, m.X, m.Y, formatScale(m.Scale))
	}
	return fmt.Sprintf(`hl.monitor({ output = %q, disabled = true })`, m.Name)
}

// parseModes groups availableModes entries by resolution, collecting refresh
// rates. Result is sorted by area (largest first), rates descending.
func parseModes(list []string) []Mode {
	type key struct{ w, h int }
	order := []key{}
	byRes := map[key]map[int]bool{}

	for _, s := range list {
		m := modeRe.FindStringSubmatch(strings.TrimSpace(s))
		if m == nil {
			continue
		}
		w, _ := strconv.Atoi(m[1])
		h, _ := strconv.Atoi(m[2])
		hz, _ := strconv.ParseFloat(m[3], 64)
		k := key{w, h}
		if byRes[k] == nil {
			byRes[k] = map[int]bool{}
			order = append(order, k)
		}
		byRes[k][int(math.Round(hz))] = true
	}

	modes := make([]Mode, 0, len(order))
	for _, k := range order {
		rates := make([]int, 0, len(byRes[k]))
		for r := range byRes[k] {
			rates = append(rates, r)
		}
		sort.Sort(sort.Reverse(sort.IntSlice(rates)))
		modes = append(modes, Mode{W: k.w, H: k.h, Rates: rates})
	}
	sort.SliceStable(modes, func(i, j int) bool {
		return modes[i].W*modes[i].H > modes[j].W*modes[j].H
	})
	return modes
}

// formatScale renders a scale without trailing noise: 1 -> "1.0", 1.5 -> "1.5".
func formatScale(s float64) string {
	if s == math.Trunc(s) {
		return strconv.FormatFloat(s, 'f', 1, 64)
	}
	return strconv.FormatFloat(s, 'f', -1, 64)
}

// persist writes ~/.config/hypr/monitors.lua, sourced by hyprland.lua via
// dofile so the layout survives reload/reboot.
func persist(mons []Monitor) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	path := filepath.Join(home, ".config", "hypr", "monitors.lua")

	var b strings.Builder
	b.WriteString("-- Generated by displays. Do not edit manually.\n")
	b.WriteString("-- Sourced from hyprland.lua via dofile().\n\n")
	for _, m := range mons {
		b.WriteString(monitorLua(m))
		b.WriteByte('\n')
	}
	return os.WriteFile(path, []byte(b.String()), 0644)
}

// hyprctl runs the Hyprland control client and returns trimmed stdout.
func hyprctl(args ...string) (string, error) {
	cmd := exec.Command("hyprctl", args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("hyprctl %s: %v: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return strings.TrimSpace(string(out)), nil
}
