terraform {
  required_version = ">= 1.3"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

data "aws_caller_identity" "current" {}


provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}

locals {
  root_domain_name       = var.root_domain_name
  assets_domain_name     = var.assets_domain_name
  site_certificate_arn   = var.acm_certificate_arn != null ? var.acm_certificate_arn : aws_acm_certificate_validation.site[0].certificate_arn
  assets_certificate_arn = var.content_acm_certificate_arn != null ? var.content_acm_certificate_arn : aws_acm_certificate_validation.assets[0].certificate_arn
  github_pat_secret_name = "${var.project_slug}/github-pat"
  lambda_role_name       = "${var.project_slug}-lambda-role"
  lambda_policy_name     = "${var.project_slug}-lambda-policy"
  lambda_function_name   = "${var.project_slug}-api"
  rewrite_function_name  = "${var.project_slug}-rewrite-index"
  coop_function_name     = "${var.project_slug}-add-coop-headers"
  site_oac_name          = "${var.project_slug}-site-oac"
  assets_oac_name        = "${var.project_slug}-assets-oac"
}

# ---------- S3: Static Site Bucket ----------

resource "aws_s3_bucket" "site" {
  bucket = var.site_bucket_name
}

resource "aws_s3_bucket_public_access_block" "site" {
  bucket                  = aws_s3_bucket.site.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_policy" "site" {
  bucket = aws_s3_bucket.site.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowCloudFrontOAC"
        Effect    = "Allow"
        Principal = { Service = "cloudfront.amazonaws.com" }
        Action    = "s3:GetObject"
        Resource  = "${aws_s3_bucket.site.arn}/*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.site.arn
          }
        }
      }
    ]
  })
}

# ---------- S3: GIF Assets Bucket ----------

resource "aws_s3_bucket" "assets" {
  bucket = var.assets_bucket_name
}

resource "aws_s3_bucket_public_access_block" "assets" {
  bucket                  = aws_s3_bucket.assets.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_cors_configuration" "assets" {
  bucket = aws_s3_bucket.assets.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "PUT"]
    allowed_origins = ["https://gifwidgets.com", "http://localhost:3000"]
    max_age_seconds = 3600
  }
}

# ---------- S3 Lifecycle: Expire temp convert files ----------

resource "aws_s3_bucket_lifecycle_configuration" "assets" {
  bucket = aws_s3_bucket.assets.id

  rule {
    id     = "expire-convert-temp"
    status = "Enabled"

    filter {
      prefix = "convert/"
    }

    expiration {
      days = 1
    }
  }
}

# ---------- Secrets Manager: GitHub PAT ----------

resource "aws_secretsmanager_secret" "github_pat" {
  name        = local.github_pat_secret_name
  description = "Fine-grained GitHub PAT for posting issues to ${var.github_repo}"
}

resource "aws_secretsmanager_secret_version" "github_pat" {
  secret_id     = aws_secretsmanager_secret.github_pat.id
  secret_string = var.github_pat
}

# ---------- IAM User for Modal Converter (GPU MP4 conversion) ----------

resource "aws_iam_user" "modal_converter" {
  name = "${var.project_slug}-modal-converter"
}

resource "aws_iam_user_policy" "modal_converter" {
  name = "${var.project_slug}-modal-converter-s3"
  user = aws_iam_user.modal_converter.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject"
        ]
        Resource = "${aws_s3_bucket.assets.arn}/convert/*"
      }
    ]
  })
}

resource "aws_iam_access_key" "modal_converter" {
  user = aws_iam_user.modal_converter.name
}

output "modal_converter_access_key_id" {
  value = aws_iam_access_key.modal_converter.id
}

output "modal_converter_secret_access_key" {
  value     = aws_iam_access_key.modal_converter.secret
  sensitive = true
}

# ---------- IAM Role for Lambda ----------

resource "aws_iam_role" "lambda" {
  name = local.lambda_role_name

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Principal = { Service = "lambda.amazonaws.com" }
        Action    = "sts:AssumeRole"
      }
    ]
  })
}

resource "aws_iam_role_policy" "lambda" {
  name = local.lambda_policy_name
  role = aws_iam_role.lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:GetObject",
          "s3:DeleteObject"
        ]
        Resource = "${aws_s3_bucket.assets.arn}/*"
      },
      {
        Effect   = "Allow"
        Action   = "s3:PutObject"
        Resource = "${aws_s3_bucket.site.arn}/g/*"
      },
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "arn:aws:logs:*:*:*"
      },
      {
        Effect   = "Allow"
        Action   = "secretsmanager:GetSecretValue"
        Resource = aws_secretsmanager_secret.github_pat.arn
      }
    ]
  })
}

# ---------- Lambda Function ----------

resource "aws_lambda_function" "api" {
  function_name = local.lambda_function_name
  role          = aws_iam_role.lambda.arn
  handler       = "handler.handler"
  runtime       = "python3.11"
  timeout       = 120
  memory_size   = 1024
  layers        = [aws_lambda_layer_version.ffmpeg.arn]

  filename         = "${path.module}/lambda.zip"
  source_code_hash = filebase64sha256("${path.module}/lambda.zip")

  environment {
    variables = {
      ASSETS_BUCKET     = aws_s3_bucket.assets.id
      SITE_BUCKET       = aws_s3_bucket.site.id
      ASSETS_CDN_URL    = "https://${local.assets_domain_name}"
      SITE_CDN_URL      = "https://${local.root_domain_name}"
      GITHUB_SECRET_ARN = aws_secretsmanager_secret.github_pat.arn
      GITHUB_REPO       = var.github_repo
    }
  }
}

# ---------- FFmpeg Lambda Layer ----------

resource "aws_lambda_layer_version" "ffmpeg" {
  layer_name          = "${var.project_slug}-ffmpeg"
  filename            = "${path.module}/ffmpeg-layer.zip"
  source_code_hash    = filebase64sha256("${path.module}/ffmpeg-layer.zip")
  compatible_runtimes = ["python3.11"]
  description         = "Static ffmpeg binary for video conversion"
}

# ---------- Lambda Function URL ----------

resource "aws_lambda_function_url" "api" {
  function_name      = aws_lambda_function.api.function_name
  authorization_type = "NONE"

  cors {
    allow_origins = ["*"]
    allow_methods = ["GET", "POST"]
    allow_headers = ["Content-Type"]
    max_age       = 3600
  }
}

resource "aws_lambda_permission" "function_url_public" {
  statement_id           = "FunctionURLAllowPublicAccess"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.api.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

# Since Oct 2025, function URLs also require lambda:InvokeFunction
resource "aws_lambda_permission" "function_url_invoke" {
  statement_id  = "FunctionURLAllowPublicInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "*"
}

# ---------- CloudFront Function: Directory Index Rewrite ----------

resource "aws_cloudfront_function" "rewrite_index" {
  name    = local.rewrite_function_name
  runtime = "cloudfront-js-2.0"
  comment = "Rewrite /path/ and /path to /path/index.html for S3 static site"
  publish = true

  code = <<-EOF
    function handler(event) {
      var request = event.request;
      var uri = request.uri;
      // Append index.html if URI ends with '/' or has no file extension
      if (uri.endsWith('/')) {
        request.uri = uri + 'index.html';
      } else if (!uri.includes('.', uri.lastIndexOf('/'))) {
        request.uri = uri + '/index.html';
      }
      return request;
    }
  EOF
}

# ---------- CloudFront Function: Add COOP/COEP headers for FFmpeg pages ----------

resource "aws_cloudfront_function" "add_coop_headers" {
  name    = local.coop_function_name
  runtime = "cloudfront-js-2.0"
  comment = "Add Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy headers for video converter pages that require SharedArrayBuffer"
  publish = true

  code = <<-EOF
    function handler(event) {
      var response = event.response;
      var uri = event.request.uri;
      if (uri.indexOf('/video-converter/') === 0) {
        response.headers['cross-origin-opener-policy'] = { value: 'same-origin' };
        response.headers['cross-origin-embedder-policy'] = { value: 'credentialless' };
      }
      return response;
    }
  EOF
}

# ---------- CloudFront ----------

resource "aws_cloudfront_origin_access_control" "site" {
  name                              = local.site_oac_name
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# OAC for the GIF assets bucket
resource "aws_cloudfront_origin_access_control" "assets" {
  name                              = local.assets_oac_name
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# CloudFront distribution for GIF assets (stable, SEO-friendly URLs)
resource "aws_cloudfront_distribution" "assets" {
  enabled = true
  comment = "${var.site_brand_name} GIF assets CDN"
  aliases = [local.assets_domain_name]

  origin {
    domain_name              = aws_s3_bucket.assets.bucket_regional_domain_name
    origin_id                = "s3-assets"
    origin_access_control_id = aws_cloudfront_origin_access_control.assets.id
  }

  default_cache_behavior {
    target_origin_id       = "s3-assets"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }

    min_ttl     = 0
    default_ttl = 86400
    max_ttl     = 31536000
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = local.assets_certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

# Allow the assets CloudFront distribution to read from the assets bucket
resource "aws_s3_bucket_policy" "assets" {
  bucket = aws_s3_bucket.assets.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowCloudFrontOAC"
        Effect    = "Allow"
        Principal = { Service = "cloudfront.amazonaws.com" }
        Action    = "s3:GetObject"
        Resource  = "${aws_s3_bucket.assets.arn}/*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.assets.arn
          }
        }
      }
    ]
  })
}

# ---------- Route 53 ----------

data "aws_route53_zone" "root" {
  count        = var.route53_zone_id == null ? 1 : 0
  name         = "${local.root_domain_name}."
  private_zone = false
}

locals {
  route53_zone_id = var.route53_zone_id != null ? var.route53_zone_id : data.aws_route53_zone.root[0].zone_id
}

resource "aws_acm_certificate" "site" {
  count             = var.acm_certificate_arn == null ? 1 : 0
  provider          = aws.us_east_1
  domain_name       = local.root_domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "site_cert_validation" {
  count = var.acm_certificate_arn == null ? 1 : 0

  zone_id = local.route53_zone_id
  name    = tolist(aws_acm_certificate.site[0].domain_validation_options)[0].resource_record_name
  type    = tolist(aws_acm_certificate.site[0].domain_validation_options)[0].resource_record_type
  ttl     = 60
  records = [tolist(aws_acm_certificate.site[0].domain_validation_options)[0].resource_record_value]
}

resource "aws_acm_certificate_validation" "site" {
  count                   = var.acm_certificate_arn == null ? 1 : 0
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.site[0].arn
  validation_record_fqdns = [aws_route53_record.site_cert_validation[0].fqdn]
}

resource "aws_acm_certificate" "assets" {
  count             = var.content_acm_certificate_arn == null ? 1 : 0
  provider          = aws.us_east_1
  domain_name       = local.assets_domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "assets_cert_validation" {
  count = var.content_acm_certificate_arn == null ? 1 : 0

  zone_id = local.route53_zone_id
  name    = tolist(aws_acm_certificate.assets[0].domain_validation_options)[0].resource_record_name
  type    = tolist(aws_acm_certificate.assets[0].domain_validation_options)[0].resource_record_type
  ttl     = 60
  records = [tolist(aws_acm_certificate.assets[0].domain_validation_options)[0].resource_record_value]
}

resource "aws_acm_certificate_validation" "assets" {
  count                   = var.content_acm_certificate_arn == null ? 1 : 0
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.assets[0].arn
  validation_record_fqdns = [aws_route53_record.assets_cert_validation[0].fqdn]
}

resource "aws_route53_record" "root" {
  zone_id = local.route53_zone_id
  name    = local.root_domain_name
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.site.domain_name
    zone_id                = aws_cloudfront_distribution.site.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "content" {
  zone_id = local.route53_zone_id
  name    = local.assets_domain_name
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.assets.domain_name
    zone_id                = aws_cloudfront_distribution.assets.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_cloudfront_distribution" "site" {
  enabled             = true
  default_root_object = "index.html"
  comment             = "${var.site_brand_name} static site"
  aliases             = [local.root_domain_name]

  origin {
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_id                = "s3-site"
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }

  default_cache_behavior {
    target_origin_id       = "s3-site"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.rewrite_index.arn
    }

    function_association {
      event_type   = "viewer-response"
      function_arn = aws_cloudfront_function.add_coop_headers.arn
    }

    min_ttl     = 0
    default_ttl = 3600
    max_ttl     = 86400
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = local.site_certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}
