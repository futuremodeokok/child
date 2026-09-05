from pathlib import Path


def test_browser_renders_all_core_allowed_grounding_actions() -> None:
    app = (Path(__file__).parents[4] / "apps" / "web" / "app.js").read_text()

    assert "for (const action of prompt.allowed_actions)" in app
    # "skip" is intentionally not a button the child clicks — Core already
    # treats an unanswered candidate as skipped (`resolve_revision` defaults
    # any prompt with no supplied decision to "skip"), so the UI only needs
    # explicit actions for the choices a child actually makes.
    for action in ("confirm", "correct", "reject"):
        assert f"{action}:" in app
    assert "case 'character':\n      return { visible_description: text }" in app


def test_full_story_panel_starts_at_top_and_remains_scrollable() -> None:
    web_dir = Path(__file__).parents[4] / "apps" / "web"
    app = (web_dir / "app.js").read_text()
    styles = (web_dir / "style.css").read_text()

    assert "textPanel.classList.toggle('full-story-panel', uiStep === 'full-story')" in app
    assert "textPanel.scrollTop = 0" in app
    assert "#text-panel.full-story-panel" in styles
    assert "justify-content: flex-start" in styles
    assert "overflow-y: auto" in styles


def test_voice_and_submit_controls_wrap_below_the_full_width_input() -> None:
    styles = (
        Path(__file__).parents[4] / "apps" / "web" / "style.css"
    ).read_text()

    assert "grid-template-columns: minmax(0, 1fr) minmax(0, 2fr)" in styles
    assert "grid-column: 1 / -1" in styles
    assert "white-space: nowrap" in styles
