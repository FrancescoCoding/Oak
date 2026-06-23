output "service_url" {
  description = "Public URL used for PUBLIC_BASE_URL and the scheduler target."
  value       = local.service_url
}

output "service_uri_actual" {
  description = "The URL Cloud Run reports. Should match service_url; verify if not."
  value       = google_cloud_run_v2_service.this.uri
}

output "artifact_registry_repo" {
  description = "Docker repository path to push images to."
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${var.repository_id}"
}

output "image" {
  description = "Full image reference the service deploys."
  value       = local.image
}

output "data_bucket" {
  description = "GCS bucket mounted at /data for sessions and schedule."
  value       = google_storage_bucket.data.name
}
