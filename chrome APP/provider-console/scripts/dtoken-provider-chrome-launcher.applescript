set appPath to POSIX path of (path to me)
set launchCommand to "APP_PATH=" & quoted form of appPath & "; if [ -d \"$APP_PATH/Contents\" ]; then ROOT_DIR=$(cd \"$APP_PATH/..\" && pwd); else ROOT_DIR=$(cd \"$(dirname \"$APP_PATH\")/..\" && pwd); fi; cd \"$ROOT_DIR\"; DTOKEN_DETACH=1 \"$ROOT_DIR/scripts/start-provider-chrome-app.sh\" >/tmp/dtoken-provider-chrome-launcher.log 2>&1 &"
do shell script launchCommand
