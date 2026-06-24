package main

import (
	"os"
	"os/exec"
	"strings"
	"testing"
)

// TestParseModes checks availableModes strings are grouped into the frontend shape.
func TestParseModes(t *testing.T) {
	in := []string{
		"2560x1600@240.00Hz",
		"2560x1600@60.00Hz",
		"1920x1200@60.00Hz",
	}
	got := parseModes(in)
	if len(got) != 2 {
		t.Fatalf("want 2 resolutions, got %d: %+v", len(got), got)
	}
	if got[0].W != 2560 || got[0].H != 1600 {
		t.Errorf("first mode should be largest 2560x1600, got %dx%d", got[0].W, got[0].H)
	}
	if len(got[0].Rates) != 2 || got[0].Rates[0] != 240 || got[0].Rates[1] != 60 {
		t.Errorf("rates should be [240 60] desc, got %v", got[0].Rates)
	}
}

func TestFormatScale(t *testing.T) {
	cases := map[float64]string{1: "1.0", 1.5: "1.5", 1.33: "1.33", 2: "2.0"}
	for in, want := range cases {
		if got := formatScale(in); got != want {
			t.Errorf("formatScale(%v) = %q, want %q", in, got, want)
		}
	}
}

func TestMonitorLua(t *testing.T) {
	on := monitorLua(Monitor{Name: "DP-3", W: 5120, H: 2160, Rate: 120, X: 2560, Y: 544, Scale: 1, Active: true})
	// Re-enabling a disabled output requires an explicit disabled = false.
	if !strings.Contains(on, "disabled = false") {
		t.Errorf("active monitor lua must clear disabled flag: %s", on)
	}
	if !strings.Contains(on, `mode = "5120x2160@120"`) || !strings.Contains(on, `position = "2560x544"`) {
		t.Errorf("active monitor lua missing mode/position: %s", on)
	}
	off := monitorLua(Monitor{Name: "DP-3", Active: false})
	if !strings.Contains(off, "disabled = true") {
		t.Errorf("inactive monitor lua must set disabled = true: %s", off)
	}
}

// TestGetMonitorsLive exercises the real data path against a running Hyprland.
// Skipped when hyprctl is unavailable (e.g. CI without a session).
func TestGetMonitorsLive(t *testing.T) {
	if _, err := exec.LookPath("hyprctl"); err != nil {
		t.Skip("hyprctl not found")
	}
	if os.Getenv("HYPRLAND_INSTANCE_SIGNATURE") == "" {
		t.Skip("no HYPRLAND_INSTANCE_SIGNATURE in env")
	}
	a := NewApp()
	mons, err := a.GetMonitors()
	if err != nil {
		t.Fatalf("GetMonitors: %v", err)
	}
	if len(mons) == 0 {
		t.Fatal("expected at least one monitor, got none")
	}
	for _, m := range mons {
		if m.Name == "" {
			t.Errorf("monitor with empty name: %+v", m)
		}
		if m.Active && (m.W == 0 || m.H == 0) {
			t.Errorf("active monitor %s has zero geometry", m.Name)
		}
		t.Logf("monitor %s %dx%d@%d scale=%v at %d,%d active=%v modes=%d",
			m.Name, m.W, m.H, m.Rate, m.Scale, m.X, m.Y, m.Active, len(m.Modes))
	}
}
