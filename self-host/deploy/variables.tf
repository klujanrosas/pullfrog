variable "instance_id" {
  description = "EC2 instance ID to deploy to"
  type        = string
  default     = "i-00d11ccbf445b0aa7" # agentes
}

variable "host" {
  description = "SSH host (public IP or DNS of the instance)"
  type        = string
  default     = "44.199.252.216"
}

variable "ssh_user" {
  description = "SSH user for the EC2 instance"
  type        = string
  default     = "ec2-user"
}

variable "ssh_private_key_path" {
  description = "Path to the SSH private key"
  type        = string
  default     = "~/.ssh/id_ed25519"
  sensitive   = true
}

variable "deploy_path" {
  description = "Remote directory for the pullfrog self-host stack"
  type        = string
  default     = "/opt/pullfrog"
}

variable "self_host_secret" {
  description = "JWT signing secret. Generate with: openssl rand -hex 32"
  type        = string
  sensitive   = true
}

variable "public_url" {
  description = "Externally-reachable URL (e.g. Cloudflare Tunnel URL). Used for upload links in PR comments."
  type        = string
  default     = "http://localhost:3456"
}

variable "port" {
  description = "Port the server listens on inside the container"
  type        = number
  default     = 3456
}

variable "open_security_group" {
  description = "Whether to add an inbound rule on port 3456 to the instance's security group. Set false if using Cloudflare Tunnel."
  type        = bool
  default     = false
}
