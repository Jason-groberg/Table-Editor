import requests
from bs4 import BeautifulSoup
import urllib.parse

def scrape_company_domain(company_name):
    """
    Fallback method to find a company's domain using a basic web search.
    This is a simple stub and might be blocked by search engines in production.
    """
    if not company_name or str(company_name) == 'nan':
        return ""
        
    query = urllib.parse.quote_plus(f"{company_name} official website")
    url = f"https://duckduckgo.com/html/?q={query}"
    
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    }
    
    try:
        response = requests.get(url, headers=headers, timeout=5)
        if response.status_code == 200:
            soup = BeautifulSoup(response.text, 'html.parser')
            # Look for the first search result link
            for a in soup.find_all('a', class_='result__url'):
                href = a.get('href')
                if href and 'http' in href:
                    # Very basic extraction, would need refinement
                    domain = href.split('//')[-1].split('/')[0]
                    # Exclude common non-company domains
                    if not any(x in domain for x in ['linkedin.com', 'facebook.com', 'duckduckgo.com']):
                        return domain
    except Exception as e:
        print(f"Scraping error for {company_name}: {e}")
        
    return ""
