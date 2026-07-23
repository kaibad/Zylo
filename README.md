# ZYLO: Professional Publishing Platform

ZYLO is a sleek, professional blog platform designed for industry insights and technical articles. It features a modern tech stack utilizing React, Node.js, and PostgreSQL.

## Features

- Clean, professional slate-themed UI
- User accounts with username/password registration and login (JWT-based)
- Publish, edit, and delete technical articles
- **Public posts** : visible to everyone on the feed
- **Private posts** : visible only to the author
- Edit and delete controls only appear for the post owner
- Discussion and comment sections for community engagement
- Responsive mobile-friendly design

## Project Structure

- `frontend/`: React + Vite frontend application.
- `backend/`: Node.js + Express API server.
- `docs/`: Additional documentation.

## Local Development

For detailed instructions on running the project locally, please see the [Local Development Guide](docs/local-development.md).

## Containerization Development

For detailed Documentaion containerizarion of project, please see the [Containerization Docs](docs/containerization.md).

## CI/CD Docs

For detailed CICD docs of project, please see the [CICD Docs](docs/cicd.md).

## Infrastructure Docs

For detailed Infra docs of project, please see the [Infrastructure Docs](docs/infra.md).

## Kubernetes Docs

For detailed K8S docs of project, please see the [Kubernetes Docs](docs/k8s.md).

## Documentation

| Document                                               | Description                                                                                                                                     |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| [Project Architecture Docs](docs/architecture.md)      | Project Architecture                                                                                                                            |
| [Setup & Architecture Docs](docs/local-development.md) | Local development setup, project architecture, API overview, database configuration, and authentication flow.                                   |
| [Containerization Docs](docs/containerization.md)      | Docker-based setup, image building, Docker Compose configuration, networking, volumes, and containerized local development.                     |
| [CI/CD Docs](docs/cicd.md)                             | CI/CD pipeline configuration, automated testing, Docker image builds, registry publishing, deployment workflow, and GitHub Actions integration. |
| [Infrastructure Docs](docs/infra.md)                   | Infrastructure architecture, cloud resources, networking, storage, environment configuration, and deployment topology.                          |
| [Kubernetes Docs](docs/k8s.md)                         | Kubernetes manifests, deployments, services, ingress, config maps, secrets, autoscaling, and cluster deployment guide.                          |
