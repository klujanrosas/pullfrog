terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = "us-east-1"
}

# ── Data sources ─────────────────────────────────────────────────────────────

data "aws_instance" "target" {
  instance_id = var.instance_id
}

locals {
  sg_ids      = data.aws_instance.target.vpc_security_group_ids
  first_sg_id = tolist(local.sg_ids)[0]
  src_dir     = "${path.module}/.."
  ssh_key     = file(pathexpand(var.ssh_private_key_path))
}

# ── Optional: open port in security group ────────────────────────────────────

resource "aws_security_group_rule" "pullfrog_inbound" {
  count             = var.open_security_group ? 1 : 0
  type              = "ingress"
  from_port         = var.port
  to_port           = var.port
  protocol          = "tcp"
  cidr_blocks       = ["0.0.0.0/0"]
  security_group_id = local.first_sg_id
  description       = "Pullfrog self-host API"
}

# ── Deploy: copy files + docker compose up ───────────────────────────────────
#
# All values the destroy provisioner needs live in `input` so it can
# reference `self.input.*` — Terraform forbids var/local refs at destroy.

resource "terraform_data" "pullfrog_deploy" {
  input = {
    host        = var.host
    user        = var.ssh_user
    private_key = local.ssh_key
    remote_dir  = var.deploy_path

    # change triggers
    src_hash   = sha256(join("", [for f in fileset(local.src_dir, "src/**/*.ts") : file("${local.src_dir}/${f}")]))
    dockerfile = file("${local.src_dir}/Dockerfile")
    compose    = file("${local.src_dir}/docker-compose.yml")
    pkg        = file("${local.src_dir}/package.json")
    secret     = var.self_host_secret
    public_url = var.public_url
    port       = var.port
  }

  # ── CREATE / UPDATE ──────────────────────────────────────────────────────

  provisioner "remote-exec" {
    connection {
      type        = "ssh"
      host        = var.host
      user        = var.ssh_user
      private_key = local.ssh_key
      timeout     = "30s"
    }
    inline = [
      "sudo mkdir -p ${var.deploy_path}/src/routes",
      "sudo chown -R ${var.ssh_user}: ${var.deploy_path}",
    ]
  }

  provisioner "file" {
    connection {
      type        = "ssh"
      host        = var.host
      user        = var.ssh_user
      private_key = local.ssh_key
      timeout     = "30s"
    }
    source      = "${local.src_dir}/Dockerfile"
    destination = "${var.deploy_path}/Dockerfile"
  }

  provisioner "file" {
    connection {
      type        = "ssh"
      host        = var.host
      user        = var.ssh_user
      private_key = local.ssh_key
      timeout     = "30s"
    }
    source      = "${local.src_dir}/package.json"
    destination = "${var.deploy_path}/package.json"
  }

  provisioner "file" {
    connection {
      type        = "ssh"
      host        = var.host
      user        = var.ssh_user
      private_key = local.ssh_key
      timeout     = "30s"
    }
    source      = "${local.src_dir}/tsconfig.json"
    destination = "${var.deploy_path}/tsconfig.json"
  }

  provisioner "file" {
    connection {
      type        = "ssh"
      host        = var.host
      user        = var.ssh_user
      private_key = local.ssh_key
      timeout     = "30s"
    }
    source      = "${local.src_dir}/src/"
    destination = "${var.deploy_path}/src"
  }

  provisioner "file" {
    connection {
      type        = "ssh"
      host        = var.host
      user        = var.ssh_user
      private_key = local.ssh_key
      timeout     = "30s"
    }
    content = templatefile("${path.module}/docker-compose.tftpl", {
      self_host_secret = var.self_host_secret
      public_url       = var.public_url
      port             = var.port
      github_pat       = var.github_pat
      webhook_secret   = var.webhook_secret
    })
    destination = "${var.deploy_path}/docker-compose.yml"
  }

  provisioner "remote-exec" {
    connection {
      type        = "ssh"
      host        = var.host
      user        = var.ssh_user
      private_key = local.ssh_key
      timeout     = "30s"
    }
    inline = [
      "cd ${var.deploy_path}",
      "docker compose build --no-cache",
      "docker compose up -d --force-recreate --remove-orphans",
      "echo '─── pullfrog-api status ───'",
      "docker compose ps",
      "sleep 3",
      "docker compose logs --tail=10",
    ]
  }

  # ── DESTROY ──────────────────────────────────────────────────────────────

  provisioner "remote-exec" {
    when = destroy
    connection {
      type        = "ssh"
      host        = self.input.host
      user        = self.input.user
      private_key = self.input.private_key
      timeout     = "30s"
    }
    inline = [
      "cd ${self.input.remote_dir} && docker compose down --remove-orphans || true",
      "echo '✓ pullfrog self-host stack torn down'",
    ]
  }
}
