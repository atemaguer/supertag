package main

import (
	"fmt"
	"strconv"
	"strings"
)

// currencySymbols are the symbols en-US formatting gives the most common currencies; others show
// their ISO 4217 code, as the CLI's money formatting does.
var currencySymbols = map[string]string{
	"USD": "$", "EUR": "€", "GBP": "£", "JPY": "¥", "CAD": "CA$", "AUD": "A$", "INR": "₹", "CNY": "CN¥",
	"KRW": "₩", "BRL": "R$", "MXN": "MX$", "NZD": "NZ$", "HKD": "HK$", "ILS": "₪", "VND": "₫", "TWD": "NT$",
}

// minorDigits are the ISO 4217 currencies whose minor unit is not a hundredth.
var minorDigits = map[string]int{
	"BIF": 0, "CLP": 0, "DJF": 0, "GNF": 0, "ISK": 0, "JPY": 0, "KMF": 0, "KRW": 0, "PYG": 0, "RWF": 0,
	"UGX": 0, "UYI": 0, "VND": 0, "VUV": 0, "XAF": 0, "XOF": 0, "XPF": 0,
	"BHD": 3, "IQD": 3, "JOD": 3, "KWD": 3, "LYD": 3, "OMR": 3, "TND": 3,
}

// money formats minor units of currency, such as 1234 USD as $12.34.
func money(minor int64, currency string) string {
	if !currencyCode(currency) {
		return fmt.Sprintf("%d %s minor units", minor, terminalText(currency))
	}
	digits, ok := minorDigits[currency]
	if !ok {
		digits = 2
	}
	sign := ""
	if minor < 0 {
		sign, minor = "-", -minor
	}
	scale := int64(1)
	for range digits {
		scale *= 10
	}
	amount := grouped(minor / scale)
	if digits > 0 {
		amount += fmt.Sprintf(".%0*d", digits, minor%scale)
	}
	if symbol, ok := currencySymbols[currency]; ok {
		return sign + symbol + amount
	}
	return sign + currency + " " + amount
}

// shortMoney is money without a fraction of zeros, for the rail: $300 rather than $300.00.
func shortMoney(minor int64, currency string) string {
	text := money(minor, currency)
	if i := strings.LastIndexByte(text, '.'); i >= 0 && strings.Trim(text[i+1:], "0") == "" {
		return text[:i]
	}
	return text
}

func currencyCode(code string) bool {
	if len(code) != 3 {
		return false
	}
	for _, r := range code {
		if r < 'A' || r > 'Z' {
			return false
		}
	}
	return true
}

// grouped writes n with thousands separators.
func grouped(n int64) string {
	digits := strconv.FormatInt(n, 10)
	var b strings.Builder
	for i, r := range digits {
		if i > 0 && (len(digits)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(r)
	}
	return b.String()
}
