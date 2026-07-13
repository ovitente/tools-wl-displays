package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
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

// ---------- apply / confirm / revert state machine ----------

// monsJSON is what the fake hyprctl serves for `monitors all -j`: one active
// output at the origin.
const monsJSON = `[{"name":"DP-1","make":"Dell","model":"U2720Q","width":2560,"height":1440,` +
	`"refreshRate":60.0,"x":0,"y":0,"scale":1.0,"disabled":false,"focused":true,` +
	`"availableModes":["2560x1440@60.00Hz"]}]`

// withFakeHyprctl swaps the hyprctl var for a stub: `monitors` returns json,
// `eval` is recorded (and fails when the lua contains failOn). Returns the
// recorded evals; access is synchronized because the auto-revert timer fires
// on its own goroutine.
func withFakeHyprctl(t *testing.T, json, failOn string) func() []string {
	t.Helper()
	orig := hyprctl
	var mu sync.Mutex
	var evals []string
	hyprctl = func(args ...string) (string, error) {
		switch args[0] {
		case "monitors":
			return json, nil
		case "eval":
			mu.Lock()
			evals = append(evals, args[1])
			mu.Unlock()
			if failOn != "" && strings.Contains(args[1], failOn) {
				return "", fmt.Errorf("fake hyprctl: forced failure")
			}
			return "ok", nil
		}
		return "", fmt.Errorf("fake hyprctl: unexpected args %v", args)
	}
	t.Cleanup(func() { hyprctl = orig })
	return func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), evals...)
	}
}

// testHome points $HOME at a temp dir (with .config/hypr present, as on a real
// system) and returns the monitors.lua path persist would write.
func testHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := os.MkdirAll(filepath.Join(home, ".config", "hypr"), 0755); err != nil {
		t.Fatal(err)
	}
	return filepath.Join(home, ".config", "hypr", "monitors.lua")
}

func testMons() []Monitor {
	return []Monitor{{Name: "DP-1", W: 2560, H: 1440, Rate: 60, Scale: 1, X: 100, Y: 0, Active: true}}
}

func TestApplyDoesNotPersist(t *testing.T) {
	withFakeHyprctl(t, monsJSON, "")
	luaPath := testHome(t)
	a := NewApp()
	if _, err := a.Apply(testMons()); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if _, err := os.Stat(luaPath); !os.IsNotExist(err) {
		t.Errorf("monitors.lua must not exist before confirm (stat err: %v)", err)
	}
	if _, err := a.RevertApply(); err != nil { // stop the timer, clean up
		t.Fatalf("RevertApply: %v", err)
	}
}

func TestConfirmPersists(t *testing.T) {
	withFakeHyprctl(t, monsJSON, "")
	luaPath := testHome(t)
	a := NewApp()
	if _, err := a.Apply(testMons()); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if err := a.ConfirmApply(); err != nil {
		t.Fatalf("ConfirmApply: %v", err)
	}
	data, err := os.ReadFile(luaPath)
	if err != nil {
		t.Fatalf("monitors.lua missing after confirm: %v", err)
	}
	if !strings.Contains(string(data), `position = "100x0"`) {
		t.Errorf("persisted lua lacks applied position: %s", data)
	}
	if err := a.ConfirmApply(); err != nil { // idempotent no-op
		t.Errorf("second ConfirmApply must no-op, got %v", err)
	}
}

func TestAutoRevert(t *testing.T) {
	origDelay := revertDelay
	revertDelay = 50 * time.Millisecond
	t.Cleanup(func() { revertDelay = origDelay })

	getEvals := withFakeHyprctl(t, monsJSON, "")
	luaPath := testHome(t)
	a := NewApp()
	if _, err := a.Apply(testMons()); err != nil {
		t.Fatalf("Apply: %v", err)
	}

	deadline := time.Now().Add(2 * time.Second)
	reverted := false
	for time.Now().Before(deadline) {
		for _, l := range getEvals()[1:] { // evals[0] is the apply itself
			if strings.Contains(l, `position = "0x0"`) {
				reverted = true
			}
		}
		if reverted {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !reverted {
		t.Fatalf("auto-revert did not re-apply the snapshot; evals: %v", getEvals())
	}
	if _, err := os.Stat(luaPath); !os.IsNotExist(err) {
		t.Errorf("monitors.lua must not exist after auto-revert (stat err: %v)", err)
	}
	// Idempotence: a late explicit revert finds nothing pending, no new evals.
	n := len(getEvals())
	if _, err := a.RevertApply(); err != nil {
		t.Fatalf("late RevertApply: %v", err)
	}
	if len(getEvals()) != n {
		t.Errorf("late RevertApply must not re-apply anything")
	}
}

func TestApplyWhilePending(t *testing.T) {
	withFakeHyprctl(t, monsJSON, "")
	testHome(t)
	a := NewApp()
	if _, err := a.Apply(testMons()); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if _, err := a.Apply(testMons()); err == nil {
		t.Error("second Apply while pending must fail")
	}
	if _, err := a.RevertApply(); err != nil {
		t.Fatalf("RevertApply: %v", err)
	}
}

func TestApplyPartialFailure(t *testing.T) {
	getEvals := withFakeHyprctl(t, monsJSON, "DP-2")
	testHome(t)
	a := NewApp()
	mons := append(testMons(),
		Monitor{Name: "DP-2", W: 1920, H: 1080, Rate: 60, Scale: 1, X: 2660, Y: 0, Active: true})
	if _, err := a.Apply(mons); err == nil {
		t.Fatal("Apply must fail when one output is rejected")
	}
	// Best-effort restore: the snapshot (DP-1 at 0,0) was re-applied.
	restored := false
	for _, l := range getEvals() {
		if strings.Contains(l, `position = "0x0"`) {
			restored = true
		}
	}
	if !restored {
		t.Errorf("snapshot not re-applied after partial failure; evals: %v", getEvals())
	}
	// Nothing pending: a fresh Apply must be accepted again.
	if _, err := a.Apply(testMons()); err != nil {
		t.Errorf("Apply after failed apply must work, got %v", err)
	}
	if _, err := a.RevertApply(); err != nil {
		t.Fatalf("RevertApply: %v", err)
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
