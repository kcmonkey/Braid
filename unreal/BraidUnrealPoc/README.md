# Braid Unreal PoC

This is a minimal Unreal Editor plugin proving that the current Braid React/React Flow webview can run inside UE through the built-in Web Browser widget.

What it does:

- Registers `Tools > Braid Canvas PoC`.
- Opens a Nomad editor tab.
- Loads `Resources/Web/index.html`.
- Boots the real Braid `out/webview.js` and `out/webview.css` bundle.
- Provides a small local `acquireVsCodeApi()` shim so the canvas can render, persist to browser localStorage, and return demo responses.

What it does not do yet:

- It does not run the real Braid host service.
- It does not call Claude, Codex, DeepSeek, or any engine adapter.
- It does not expose Unreal selected actors, assets, logs, or map state.

To install into the target project, place this folder at:

```text
D:\ContractorsShowdown_New\Plugins\BraidUnrealPoc
```

Then enable the plugin in the editor or add this entry to `Contractors_Showdown.uproject`:

```json
{
  "Name": "BraidUnrealPoc",
  "Enabled": true
}
```

The plugin depends on Unreal's built-in `WebBrowserWidget` plugin.
