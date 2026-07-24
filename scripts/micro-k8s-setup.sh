#!/bin/bash
set -e

echo "=== Phase 1: System Update ==="
sudo apt-get update && sudo apt-get upgrade -y

echo "=== Phase 2: Install Docker ==="
sudo apt-get install -y docker.io
sudo usermod -aG docker $USER
sudo systemctl enable docker && sudo systemctl start docker
newgrp docker

echo "=== Phase 3: Install kubectl ==="

curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
sudo install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl
rm kubectl

# Verify
kubectl version --client

echo "=== Phase 4: Install Helm ==="
curl -fsSL -o get_helm.sh https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-4
chmod 700 get_helm.sh
./get_helm.sh

echo "=== Phase 5: Install MicroK8s ==="
sudo snap install microk8s --classic --channel=1.31/stable
sudo usermod -aG microk8s $USER
mkdir -p ~/.kube && sudo chown -R $USER ~/.kube
newgrp microk8s || true

echo "=== Phase 6: Enable MicroK8s Addons ==="
microk8s enable dns hostpath-storage ingress metrics-server helm3 dashboard registry

echo "=== Phase 7: Configure kubectl ==="
microk8s config > ~/.kube/config
echo 'export KUBECONFIG=~/.kube/config' >> ~/.bashrc
echo "alias k='microk8s kubectl'" >> ~/.bashrc
echo "alias kubectl='microk8s kubectl'" >> ~/.bashrc
echo "alias helm='microk8s helm3'" >> ~/.bashrc

echo "=== Phase 8: Setup Postgres Storage ==="
sudo mkdir -p /data/postgres
sudo chmod 777 /data/postgres
sudo chown -R 999:999 /data/postgres

echo "=== Setup Complete! ==="
echo "Log out and log back in, then create your Helm chart and deploy."