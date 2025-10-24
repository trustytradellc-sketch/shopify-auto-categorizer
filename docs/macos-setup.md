# macOS (iMac) Deployment Guide

This guide walks through running the Shopify auto categorizer on a dedicated iMac. It assumes you want the service to stay online all the time so you can trigger commands from your phone.

## 1. Prerequisites

1. **Install Homebrew (if you do not have it yet)**
   ```bash
   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
   ```
2. **Install Node.js 20 LTS and Git**
   ```bash
   brew install node@20 git
   ```
   Homebrew will print the path to the `node@20` binary. Export it in your shell profile (e.g. `~/.zshrc`):
   ```bash
   echo 'export PATH="/opt/homebrew/opt/node@20/bin:$PATH"' >> ~/.zshrc
   source ~/.zshrc
   ```
3. **Clone the repository**
   ```bash
   mkdir -p ~/apps
   cd ~/apps
   git clone https://github.com/YOUR-ORG/shopify-auto-categorizer.git
   cd shopify-auto-categorizer
   npm install
   ```

## 2. Environment configuration

1. Copy the sample environment file and update it with the secrets you shared (`SHOPIFY_ACCESS_TOKEN`, `COMMAND_TOKEN`, etc.).
   ```bash
   cp .env.example .env
   open -a TextEdit .env
   ```
2. Double-check the `PORT` value (default: `3000`). If you plan to expose the service through your router, you can keep this default and forward HTTP traffic to your iMac.

## 3. Local testing

Start the development server and make sure the health check responds.
```bash
npm run dev
```
Visit `http://localhost:3000/health` from a browser on the iMac. You should see `{ "ok": true }`. Stop the process with `Ctrl+C` once everything looks fine.

## 4. Launchd service (auto start on boot)

To keep the app running on the iMac even after you log out or reboot, use a launch agent. The repository includes a sample property list at [`scripts/launchd/com.trustytrade.autocategorizer.plist`](../scripts/launchd/com.trustytrade.autocategorizer.plist).

1. Edit the plist so that the `ProgramArguments` path matches your checkout location and your preferred Node.js binary.
   ```bash
   open -a TextEdit scripts/launchd/com.trustytrade.autocategorizer.plist
   ```
2. Copy the file into your LaunchAgents folder:
   ```bash
   mkdir -p ~/Library/LaunchAgents
   cp scripts/launchd/com.trustytrade.autocategorizer.plist ~/Library/LaunchAgents/
   ```
3. Load the agent:
   ```bash
   launchctl load ~/Library/LaunchAgents/com.trustytrade.autocategorizer.plist
   ```
4. Check the logs:
   ```bash
   log show --style compact --predicate 'process == "node"' --last 1h
   ```

The server will now run automatically in the background and restart if it crashes. When you change the code or `.env`, unload and reload the agent:
```bash
launchctl unload ~/Library/LaunchAgents/com.trustytrade.autocategorizer.plist
launchctl load ~/Library/LaunchAgents/com.trustytrade.autocategorizer.plist
```

## 5. Exposing the webhook to Shopify

Shopify needs to reach your iMac from the internet. You have a few options:

1. **Cloudflare Tunnel (recommended)**
   - Install the Cloudflare tunnel client:
     ```bash
     brew install cloudflare/cloudflare/cloudflared
     ```
   - Authenticate and create a tunnel to `http://localhost:3000` following the [Cloudflare docs](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/tunnel-guide/remote).
   - Use the generated public hostname in Shopify webhook configuration (`https://your-subdomain.trycloudflare.com/webhooks/shopify/products`).
2. **ngrok**
   - Install ngrok: `brew install ngrok/ngrok/ngrok`
   - Start a tunnel: `ngrok http 3000`
   - Copy the forwarding URL and set it in Shopify Notifications.
3. **Router port forwarding**
   - Configure your home/office router to forward external port 443 to your iMac's port 3000.
   - Secure the connection with a reverse proxy (Caddy, Nginx) and HTTPS certificates.

## 6. Keeping the repository up to date

Periodically pull the latest changes and reload the launch agent:
```bash
cd ~/apps/shopify-auto-categorizer
git pull
npm install
launchctl unload ~/Library/LaunchAgents/com.trustytrade.autocategorizer.plist
launchctl load ~/Library/LaunchAgents/com.trustytrade.autocategorizer.plist
```

## 7. Remote control checklist

- Confirm that `COMMAND_TOKEN` is set in `.env`.
- Make sure your tunnel/port forwarding exposes the `/commands` endpoint securely (HTTPS recommended).
- Use the same token from your phone or ChatGPT Action when sending commands.

With this setup, the iMac can stay online and reliably process Shopify catalog updates while you manage it remotely.
