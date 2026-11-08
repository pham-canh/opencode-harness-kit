Output docs/assets/demo.gif
Set FontFamily "DejaVu Sans Mono"
Set FontSize 15
Set Width 1200
Set Height 700
Set Padding 24
Set Margin 0
Set Theme "Catppuccin Mocha"
Set TypingSpeed 35ms
Set PlaybackSpeed 1.25

Hide
Type "export HOME=/tmp/h; export npm_config_cache=/tmp/h/.npm; export npm_config_loglevel=error; export npm_config_update_notifier=false; export NO_UPDATE_NOTIFIER=1; export PS1='~/calc $ '; cd /tmp/oc-demo-project; clear"
Enter
Sleep 500ms
Show

Type "npx -y opencode-harness-kit@latest init --model zai/glm-4.7-flash --retention zero-retention"
Enter
Sleep 8s

Type "npx -y opencode-harness-kit@latest doctor"
Enter
Sleep 3s
