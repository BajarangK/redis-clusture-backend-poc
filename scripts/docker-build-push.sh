#!/usr/bin/env bash
# Usage: ./scripts/docker-build-push.sh [version]
# Example: ./scripts/docker-build-push.sh 1.0.0
#          ./scripts/docker-build-push.sh 2.2.0

set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="${1:-$(tr -d '[:space:]' < VERSION)}"
IMAGE="shehzadroyalcyber/redis-cluster-poc:${VERSION}"

echo "${VERSION}" > VERSION
sed -i.bak "s|image: shehzadroyalcyber/redis-cluster-poc:.*|image: ${IMAGE}|" k8s.yaml
rm -f k8s.yaml.bak

echo "Building ${IMAGE}..."
docker build -t "${IMAGE}" -t "shehzadroyalcyber/redis-cluster-poc:latest" .

echo "Pushing ${IMAGE}..."
docker push "${IMAGE}"
docker push "shehzadroyalcyber/redis-cluster-poc:latest"

echo "Done. Image: ${IMAGE}"
echo "On QA server (kubectl only):"
echo "  kubectl apply -f k8s.yaml"
echo "  kubectl set image deployment/redis-cluster-poc redis-cluster-poc=${IMAGE} -n redis-cluster"
echo "  kubectl rollout status deployment/redis-cluster-poc -n redis-cluster"
