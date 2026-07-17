#!/bin/bash
# ============================================
# Zylo Blog Platform - EC2 Deployment Script
# Ubuntu 22.04/24.04
# ============================================

set -e

APP_NAME="zylo"
APP_DIR="/var/www/$APP_NAME"
REPO_URL="https://github.com/kaibad/Zylo.git"
BRANCH="main"

DB_NAME="zylo_db"
DB_USER="zylo_user"
DB_PASSWORD="Zylo_pass"

echo "==========================================="
echo " Deploying Zylo Blog Platform"
echo "==========================================="

# Update system
echo "Updating packages..."

sudo apt update
sudo apt upgrade -y

# Install dependencies
echo "Installing system dependencies..."
sudo apt install -y \
    git \
    curl \
    nginx \
    postgresql \
    postgresql-contrib \
    build-essential


# Install Node.js using NVM
echo "Installing Node.js..."

export NVM_DIR="$HOME/.nvm"

if [ ! -d "$NVM_DIR" ]; then
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.5/install.sh | bash
fi

[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

nvm install 20
nvm use 20

echo "Node:"
node -v

echo "npm:"
npm -v

# Install PM2
echo "Installing PM2..."
npm install -g pm2

cat >> ~/.bashrc <<'EOF'

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

EOF


# Clone application
echo "Cloning Zylo repository..."

sudo mkdir -p /var/www
sudo chown -R $USER:$USER /var/www


if [ -d "$APP_DIR" ]; then
    echo "Existing installation found. Updating..."

    cd "$APP_DIR"
    git pull origin $BRANCH

else

    git clone \
        -b $BRANCH \
        $REPO_URL \
        $APP_DIR

fi

cd $APP_DIR

# PostgreSQL setup
echo "Configuring PostgreSQL..."

sudo systemctl enable postgresql
sudo systemctl start postgresql

sudo -u postgres psql <<EOF

DO \$\$
BEGIN
    IF NOT EXISTS (
        SELECT FROM pg_roles WHERE rolname='$DB_USER'
    )
    THEN
        CREATE USER $DB_USER WITH PASSWORD '$DB_PASSWORD';
    END IF;
END
\$\$;


SELECT 'CREATE DATABASE $DB_NAME OWNER $DB_USER'
WHERE NOT EXISTS (
    SELECT FROM pg_database WHERE datname='$DB_NAME'
)
\gexec


GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;

EOF

echo "Database ready"


# Backend setup
echo "Installing backend..."

cd $APP_DIR/backend
cat > .env <<EOF
PORT=5000

DB_USER=$DB_USER
DB_PASSWORD=$DB_PASSWORD
DB_HOST=localhost
DB_PORT=5432
DB_NAME=$DB_NAME
EOF

npm ci --omit=dev


# Frontend build
echo "Building frontend..."

cd $APP_DIR/frontend

npm ci
npm run build


# Nginx setup
echo "Configuring nginx..."


sudo tee /etc/nginx/sites-available/$APP_NAME > /dev/null <<EOF

server {

    listen 80;
    server_name _;
    
    root $APP_DIR/frontend/dist;
    index index.html;

    location / {

        try_files \$uri \$uri/ /index.html;

    }
    location /api/ {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
    }
}

EOF

sudo ln -sf \
/etc/nginx/sites-available/$APP_NAME \
/etc/nginx/sites-enabled/$APP_NAME

sudo rm -f /etc/nginx/sites-enabled/default

sudo nginx -t

sudo systemctl restart nginx
sudo systemctl enable nginx


# Start backend PM2
echo "Starting backend..."

cd $APP_DIR/backend

pm2 delete $APP_NAME-backend || true
pm2 start src/index.js \
--name $APP_NAME-backend

pm2 save
STARTUP_CMD=$(pm2 startup systemd -u $USER --hp /home/$USER | grep "sudo env")
if [ -n "$STARTUP_CMD" ]; then
    eval "$STARTUP_CMD"
fi

# Firewall
echo "Configuring firewall..."


sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable

# Finish
TOKEN=$(curl -X PUT "http://169.254.169.254/latest/api/token" \
-H "X-aws-ec2-metadata-token-ttl-seconds: 21600")

PUBLIC_IP=$(curl -s \
-H "X-aws-ec2-metadata-token: $TOKEN" \
http://169.254.169.254/latest/meta-data/public-ipv4)

echo ""
echo "==========================================="
echo " Zylo Deployment Completed"
echo "==========================================="
echo ""
echo "Website:"
echo "http://$PUBLIC_IP"
echo ""
echo "PM2:"
echo "pm2 status"
echo "pm2 logs zylo-backend"
echo ""
echo "Nginx:"
echo "sudo systemctl status nginx"
echo ""