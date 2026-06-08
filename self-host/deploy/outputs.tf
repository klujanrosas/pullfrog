output "instance_ip" {
  description = "Public IP of the instance running pullfrog self-host"
  value       = var.host
}

output "api_url" {
  description = "Direct API URL (use this or your Cloudflare Tunnel URL)"
  value       = "http://${var.host}:${var.port}"
}

output "public_url" {
  description = "Public URL configured for upload links"
  value       = var.public_url
}

output "deploy_path" {
  description = "Remote path where the stack lives"
  value       = var.deploy_path
}

output "workflow_env_block" {
  description = "Copy this into your GitHub Actions workflow env block"
  value       = <<-EOT
    env:
      API_URL: ${var.public_url}
      CLAUDE_CODE_OAUTH_TOKEN: ${"$"}{{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
  EOT
}
