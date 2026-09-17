# Look up the manually created zones; do not create replacement hosted zones.
data "aws_route53_zone" "additional_site" {
  for_each     = toset(values(var.additional_site_domains))
  name         = each.value
  private_zone = false
}

resource "aws_route53_record" "additional_site" {
  for_each = var.additional_site_domains
  zone_id  = data.aws_route53_zone.additional_site[each.value].zone_id
  name     = each.key
  type     = "A"

  alias {
    name                   = aws_cloudfront_distribution.site.domain_name
    zone_id                = aws_cloudfront_distribution.site.hosted_zone_id
    evaluate_target_health = false
  }
}
