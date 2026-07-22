terraform {
  required_version = ">=1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
      # versi
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }

  }
  # backend "s3" {
  # 	bucket = "terraform-state-2026-tetris"
  # 	key	= "tetris/terraform.tfstate"
  # 	region = "us-east-1"
  # 	dynamodb_table = "terraform-state-lock"
  # 	decrypt = true
  # }

}
